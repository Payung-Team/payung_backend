/**
 * PYG-356 [QA] Check-in — two-tier radius, asymmetric window, server-time, dup.
 *
 * Exercises the REAL MonitoringService against the 23 TCs. Run with the TC thresholds:
 *   WARN=200 DECISION=500 EARLY_GRACE=120 LATE=30 GPS-trust=200  (EARLY_GRACE default is 60 —
 *   set via the run command). Distance is seeded by a due-north offset: metersPerDeg =
 *   6_371_000 * π/180, so evaluate()'s haversine returns the target metre value exactly.
 */
// Pin the TC-specified thresholds BEFORE the service/constants module loads (constants read
// process.env at import time). Makes the suite hermetic + CI-safe regardless of the CI env.
// NB: EARLY_GRACE default is 60; the TC uses 120 — set here so TC_10 (90min-early) must-not-flag.
process.env.WARN_RADIUS_M = '200';
process.env.VERDICT_RADIUS_M = '500';
process.env.EARLY_GRACE_MIN = '120';
process.env.LATE_VERDICT_MIN = '30';
process.env.GPS_ACCURACY_TRUST_M = '200';
process.env.CLOCK_ANOMALY_TOLERANCE_MIN = '10';

import { BadRequestException, ForbiddenException } from '@nestjs/common';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { MonitoringService } = require('./monitoring.service');
import type { MonitoringService as MonitoringServiceT } from './monitoring.service';

const JOB = { lat: 13.7563, lng: 100.5018 };
const M_PER_DEG = 6_371_000 * (Math.PI / 180); // 111194.93 — matches the code's R
/** a point exactly D metres due-north of the job site. */
const northOf = (d: number) => ({ lat: JOB.lat + d / M_PER_DEG, lng: JOB.lng });

/** evaluate() is pure — build a service with dummy deps just to call it. */
function pureService(): MonitoringServiceT {
  return new MonitoringService(
    {} as never, {} as never, {} as never, {} as never, {} as never,
  );
}

const START = new Date('2026-08-20T02:00:00.000Z'); // scheduled start (09:00 ICT)
function evalAt(opts: {
  d?: number | null;
  accuracyM?: number | null;
  minutesFromStart?: number;
  deviceTs?: Date | null;
  nullCoords?: boolean;
}) {
  const svc = pureService();
  const pt = opts.nullCoords ? null : northOf(opts.d ?? 0);
  const serverTs = new Date(START.getTime() + (opts.minutesFromStart ?? 0) * 60000);
  return svc.evaluate({
    eventLat: pt ? pt.lat : null,
    eventLng: pt ? pt.lng : null,
    accuracyM: opts.accuracyM ?? null,
    jobLat: opts.nullCoords ? null : JOB.lat,
    jobLng: opts.nullCoords ? null : JOB.lng,
    serverTs,
    deviceTs: opts.deviceTs ?? null,
    scheduledStart: START,
  });
}

describe('PYG-356 Check-in — evaluate() (radius / window / accuracy / clock / coords)', () => {
  it('TC_02 350m warn band → SUCCEEDS, no out_of_radius (withinWarnRadius=false → UI warns)', () => {
    const r = evalAt({ d: 350, accuracyM: 20 });
    expect(r.distanceM).toBe(350);
    expect(r.reviewReasons).toEqual([]);
    expect(r.withinWarnRadius).toBe(false);
  });

  it('TC_03 199m → no flag; below warn band (withinWarnRadius=true → no warn)', () => {
    const r = evalAt({ d: 199 });
    expect(r.distanceM).toBe(199);
    expect(r.reviewReasons).toEqual([]);
    expect(r.withinWarnRadius).toBe(true);
  });

  it('TC_04 200m → no flag; WARN boundary', () => {
    const r = evalAt({ d: 200 });
    expect(r.distanceM).toBe(200);
    expect(r.reviewReasons).toEqual([]); // money-critical: no flag ✓
    // ⚠ TC expects "enters warn band → UI warns"; code treats 200 as inclusive-safe:
    expect(r.withinWarnRadius).toBe(true); // → UI would NOT warn (boundary discrepancy, UI-only)
  });

  it('TC_05 201m → no flag; inside warn band (UI warns)', () => {
    const r = evalAt({ d: 201 });
    expect(r.reviewReasons).toEqual([]);
    expect(r.withinWarnRadius).toBe(false);
  });

  it('TC_06 499m → no flag (just below DECISION)', () => {
    const r = evalAt({ d: 499 });
    expect(r.distanceM).toBe(499);
    expect(r.reviewReasons).toEqual([]);
  });

  it('TC_07 500m → no flag (DECISION inclusive)', () => {
    const r = evalAt({ d: 500 });
    expect(r.distanceM).toBe(500);
    expect(r.reviewReasons).toEqual([]);
  });

  it('TC_08 501m → out_of_radius (first flagging value)', () => {
    const r = evalAt({ d: 501 });
    expect(r.distanceM).toBe(501);
    expect(r.reviewReasons).toEqual(['out_of_radius']);
  });

  it('TC_09 900m, accurate (acc 20) → out_of_radius, not blocked', () => {
    const r = evalAt({ d: 900, accuracyM: 20 });
    expect(r.reviewReasons).toEqual(['out_of_radius']);
    expect(r.gpsAccuracyLow).toBe(false);
  });

  it('TC_10 90min early (EARLY_GRACE=120) → NOT flagged', () => {
    const r = evalAt({ d: 150, minutesFromStart: -90 });
    expect(r.reviewReasons).toEqual([]); // must-not-flag
  });

  it('TC_11 45min late (LATE=30) → out_of_window', () => {
    const r = evalAt({ d: 150, minutesFromStart: 45 });
    expect(r.reviewReasons).toContain('out_of_window');
  });

  it('TC_12 device clock = yesterday → clock_anomaly (server_ts unaffected)', () => {
    const yesterday = new Date(START.getTime() - 24 * 60 * 60 * 1000);
    const r = evalAt({ d: 150, deviceTs: yesterday });
    expect(r.reviewReasons).toContain('clock_anomaly');
  });

  it('TC_18 NULL job coords → distance null, no flag, jobCoordsMissing', () => {
    const r = evalAt({ nullCoords: true });
    expect(r.distanceM).toBeNull();
    expect(r.reviewReasons).toEqual([]);
    expect(r.jobCoordsMissing).toBe(true);
  });

  it('TC_19 900m, acc 3000 (desktop) → suppress out_of_radius, gpsAccuracyLow', () => {
    const r = evalAt({ d: 900, accuracyM: 3000 });
    expect(r.distanceM).toBe(900);
    expect(r.reviewReasons).toEqual([]); // ★★ money-critical
    expect(r.gpsAccuracyLow).toBe(true);
  });

  it('TC_20 900m, acc 199 (≤200 trusted) → out_of_radius', () => {
    const r = evalAt({ d: 900, accuracyM: 199 });
    expect(r.reviewReasons).toEqual(['out_of_radius']);
    expect(r.gpsAccuracyLow).toBe(false);
  });

  it('TC_21 900m, acc 200 (boundary inclusive-trusted) → out_of_radius', () => {
    const r = evalAt({ d: 900, accuracyM: 200 });
    expect(r.reviewReasons).toEqual(['out_of_radius']);
    expect(r.gpsAccuracyLow).toBe(false);
  });

  it('TC_22 900m, acc 201 (>200 untrusted) → suppress, gpsAccuracyLow', () => {
    const r = evalAt({ d: 900, accuracyM: 201 });
    expect(r.reviewReasons).toEqual([]);
    expect(r.gpsAccuracyLow).toBe(true);
  });

  it('TC_23 900m, acc null (older client) → out_of_radius, gpsAccuracyLow=false', () => {
    const r = evalAt({ d: 900, accuracyM: null });
    expect(r.reviewReasons).toEqual(['out_of_radius']);
    expect(r.gpsAccuracyLow).toBe(false);
  });
});

// ── full checkInBooking flow: guards / idempotency / happy path ──────────────
const OWNER_USER = 'user-cg-1';
const CAREGIVER_ID = 'cg-1';
const BOOKING_ID = 'bk-1';

function fakeBooking(over: Record<string, unknown> = {}) {
  return {
    id: BOOKING_ID,
    caregiverId: CAREGIVER_ID,
    status: 'confirmed',
    bookingDate: new Date('2026-08-20T00:00:00.000Z'),
    // startTime UTC-hours are read as ICT wall-clock by scheduledStartOf (−7h):
    // 09:00 here → scheduled 02:00Z, which equals the clock `now` below (on-time).
    startTime: new Date('1970-01-01T09:00:00.000Z'),
    locationLat: JOB.lat, // Number(value) in toNumber() handles plain numbers
    locationLng: JOB.lng,
    reviewReasons: [],
    payment: { paymentStatus: 'held' },
    jobEvents: [],
    ...over,
  };
}

function makeService(booking: unknown, nowIso = '2026-08-20T02:00:00.000Z') {
  const created = {
    id: 'je-1', bookingId: BOOKING_ID, eventType: 'check_in', source: 'caregiver',
    lat: null, lng: null, distanceM: 150, accuracyM: null,
    serverTs: new Date(nowIso), deviceTs: null, note: null, photoUrl: null,
  };
  const prisma = {
    caregiver: { findUnique: jest.fn().mockResolvedValue({ id: CAREGIVER_ID }) },
    booking: { findUnique: jest.fn().mockResolvedValue(booking), update: jest.fn() },
    jobEvent: { create: jest.fn(), findFirst: jest.fn() },
    $transaction: jest.fn().mockResolvedValue([created, {}]),
  };
  const clock = { now: () => new Date(nowIso) };
  const svc = new MonitoringService(
    prisma as never, {} as never, clock as never, {} as never, {} as never,
  );
  return { svc, prisma, created };
}

const checkIn = (svc: MonitoringServiceT, extra: Record<string, unknown> = {}) =>
  svc.checkInBooking(OWNER_USER, { bookingId: BOOKING_ID, ...northOf(150), ...extra } as never);

describe('PYG-356 Check-in — checkInBooking flow (guards / dup / happy)', () => {
  it('TC_01 on-time, in-radius, owner → in_progress, one row, no flags', async () => {
    const { svc, prisma } = makeService(fakeBooking());
    await checkIn(svc);
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    // one jobEvent create, source caregiver, distance 150
    const createArg = prisma.jobEvent.create.mock.calls[0][0].data;
    expect(createArg.source).toBe('caregiver');
    expect(createArg.distanceM).toBe(150);
    // booking → in_progress, reviewReasons []
    const updateArg = prisma.booking.update.mock.calls[0][0].data;
    expect(updateArg.status).toBe('in_progress');
    expect(updateArg.reviewReasons).toEqual({ set: [] });
  });

  it('TC_13 duplicate check-in → idempotent (existing row returned, no new write)', async () => {
    const existing = {
      id: 'je-existing', bookingId: BOOKING_ID, eventType: 'check_in', source: 'caregiver',
      lat: null, lng: null, distanceM: 150, accuracyM: null,
      serverTs: new Date(), deviceTs: null, note: null, photoUrl: null,
    };
    const { svc, prisma } = makeService(fakeBooking({ jobEvents: [existing] }));
    const res = await checkIn(svc);
    expect(res.id).toBe('je-existing');
    expect(prisma.$transaction).not.toHaveBeenCalled(); // no second write
    expect(prisma.jobEvent.create).not.toHaveBeenCalled();
  });

  it('TC_14 booking still accepted → BLOCKED (Thai), no write', async () => {
    const { svc, prisma } = makeService(fakeBooking({ status: 'accepted' }));
    await expect(checkIn(svc)).rejects.toThrow('งานนี้ยังไม่พร้อมเริ่ม');
    await expect(checkIn(svc)).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('TC_15 payment pending → BLOCKED, no write', async () => {
    const { svc, prisma } = makeService(
      fakeBooking({ payment: { paymentStatus: 'pending' } }),
    );
    await expect(checkIn(svc)).rejects.toThrow('ยังไม่ได้รับการชำระเงิน');
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('TC_16 non-owner caregiver → BLOCKED with exact Thai string', async () => {
    const { svc } = makeService(fakeBooking({ caregiverId: 'cg-OTHER' }));
    await expect(checkIn(svc)).rejects.toThrow('งานนี้ไม่ใช่ของคุณ');
    await expect(checkIn(svc)).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('TC_17 service date tomorrow → BLOCKED, no write', async () => {
    const { svc, prisma } = makeService(
      fakeBooking({ bookingDate: new Date('2026-08-21T00:00:00.000Z') }),
    );
    await expect(checkIn(svc)).rejects.toThrow('ยังไม่ถึงวันทำงาน');
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });
});
