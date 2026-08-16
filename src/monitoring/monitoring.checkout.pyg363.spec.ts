/**
 * PYG-363 [QA] Check-out — duration, evidence-path security, array flags.
 *
 * Exercises the REAL MonitoringService.checkOutBooking against the dev-merged behaviour
 * (PYG-358). Prisma/Clock/Config mocked; distance seeded by a due-north offset.
 * Sweeper cases (TC_09/10/14) live in PYG-359 (PR #28) and are covered by that suite —
 * see the QA report. TC_12 is Web/realtime (out of BE scope); TC_15 is copy (report note).
 */
process.env.WARN_RADIUS_M = '200';
process.env.VERDICT_RADIUS_M = '500';
process.env.MIN_DURATION_RATIO = '0.8';

import { BadRequestException } from '@nestjs/common';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { MonitoringService } = require('./monitoring.service');
import type { MonitoringService as MonitoringServiceT } from './monitoring.service';

const JOB = { lat: 13.7563, lng: 100.5018 };
const M_PER_DEG = 6_371_000 * (Math.PI / 180);
const northOf = (d: number) => ({ lat: JOB.lat + d / M_PER_DEG, lng: JOB.lng });

const CAREGIVER_ID = 'cg-1';
const OWNER_USER = 'user-cg-1';
const BOOKING_ID = 'bk-1';
const SUPA = 'https://proj.supabase.co';
const CHECKIN_TS = new Date('2026-08-20T02:00:00.000Z'); // 09:00 ICT

function checkInRow(over: Record<string, unknown> = {}) {
  return {
    id: 'je-in', bookingId: BOOKING_ID, eventType: 'check_in', source: 'caregiver',
    lat: null, lng: null, distanceM: null, accuracyM: null,
    serverTs: CHECKIN_TS, deviceTs: null, note: null, photoUrl: null, ...over,
  };
}

function fakeBooking(over: Record<string, unknown> = {}) {
  return {
    id: BOOKING_ID,
    caregiverId: CAREGIVER_ID,
    status: 'in_progress',
    durationHours: 3, // 180 booked minutes
    locationLat: JOB.lat,
    locationLng: JOB.lng,
    disputeStatus: 'none',
    patientId: 'pt-1',
    reviewReasons: [] as string[],
    jobEvents: [checkInRow()],
    ...over,
  };
}

function makeService(booking: unknown, nowIso: string) {
  const created = {
    id: 'je-out', bookingId: BOOKING_ID, eventType: 'check_out', source: 'caregiver',
    lat: null, lng: null, distanceM: null, accuracyM: null,
    serverTs: new Date(nowIso), deviceTs: null, note: null, photoUrl: null,
  };
  const prisma = {
    caregiver: { findUnique: jest.fn().mockResolvedValue({ id: CAREGIVER_ID }) },
    booking: { findUnique: jest.fn().mockResolvedValue(booking), update: jest.fn() },
    jobEvent: { create: jest.fn() },
    $transaction: jest.fn().mockResolvedValue([created, {}]),
  };
  const clock = { now: () => new Date(nowIso) };
  const config = { get: (k: string) => (k === 'SUPABASE_URL' ? SUPA : undefined) };
  const events = { emit: jest.fn() };
  const svc: MonitoringServiceT = new MonitoringService(
    prisma as never, {} as never, clock as never, config as never, events as never,
  );
  return { svc, prisma };
}

/** now = check_in + N minutes → controls actualMinutes. */
const nowPlus = (min: number) => new Date(CHECKIN_TS.getTime() + min * 60000).toISOString();
const checkOut = (svc: MonitoringServiceT, input: Record<string, unknown> = {}) =>
  svc.checkOutBooking(OWNER_USER, { bookingId: BOOKING_ID, ...input } as never);

describe('PYG-363 Check-out — guards / duration / flags', () => {
  it('TC_01 no check_in → BLOCKED (Thai), no write', async () => {
    const { svc, prisma } = makeService(fakeBooking({ jobEvents: [] }), nowPlus(180));
    await expect(checkOut(svc)).rejects.toThrow('ยังไม่ได้เช็คอิน จึงเช็คเอาท์ไม่ได้');
    await expect(checkOut(svc)).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('TC_02 normal 180/180 → actualMinutes=180, no flags, valid, awaiting_release', async () => {
    const { svc, prisma } = makeService(fakeBooking(), nowPlus(180));
    await checkOut(svc);
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    const upd = prisma.booking.update.mock.calls[0][0].data;
    expect(upd.status).toBe('awaiting_release');
    expect(upd.reviewReasons).toEqual({ set: [] });
  });

  it('TC_03 short 120/180 (66%) → short_duration, needs_review', async () => {
    const { svc, prisma } = makeService(fakeBooking(), nowPlus(120));
    await checkOut(svc);
    const upd = prisma.booking.update.mock.calls[0][0].data;
    expect(upd.reviewReasons.set).toContain('short_duration');
    expect(upd.status).toBe('needs_review');
  });

  it('TC_04 boundary 143/180 (79.4% < 80%) → short_duration, needs_review', async () => {
    const { svc, prisma } = makeService(fakeBooking(), nowPlus(143));
    await checkOut(svc);
    const upd = prisma.booking.update.mock.calls[0][0].data;
    expect(upd.reviewReasons.set).toContain('short_duration');
    expect(upd.status).toBe('needs_review');
  });

  it('TC_05 boundary 144/180 (=80% inclusive) → NOT short, valid, awaiting_release', async () => {
    const { svc, prisma } = makeService(fakeBooking(), nowPlus(144));
    await checkOut(svc);
    const upd = prisma.booking.update.mock.calls[0][0].data;
    expect(upd.reviewReasons.set).not.toContain('short_duration');
    expect(upd.status).toBe('awaiting_release');
  });

  it('TC_06 photoUrl external domain → REJECTED, no write', async () => {
    const { svc, prisma } = makeService(fakeBooking(), nowPlus(180));
    await expect(checkOut(svc, { photoUrl: 'https://evil.com/x.jpg' }))
      .rejects.toThrow('ไฟล์แนบไม่ถูกต้อง');
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('TC_07 photoUrl our host but kyc-documents bucket → REJECTED', async () => {
    const { svc, prisma } = makeService(fakeBooking(), nowPlus(180));
    const url = `${SUPA}/storage/v1/object/sign/kyc-documents/${BOOKING_ID}/x.jpg`;
    await expect(checkOut(svc, { photoUrl: url })).rejects.toThrow('ไฟล์แนบไม่ถูกต้อง');
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('TC_08 job-evidence but ANOTHER booking folder → REJECTED', async () => {
    const { svc, prisma } = makeService(fakeBooking(), nowPlus(180));
    const url = `${SUPA}/storage/v1/object/sign/job-evidence/OTHER-booking/x.jpg`;
    await expect(checkOut(svc, { photoUrl: url })).rejects.toThrow('ไฟล์แนบไม่ถูกต้อง');
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('TC_11 valid note + photo under this booking → persisted (path stored, note kept)', async () => {
    const { svc, prisma } = makeService(fakeBooking(), nowPlus(180));
    await checkOut(svc, { note: 'งานเรียบร้อย', photoUrl: `job-evidence/${BOOKING_ID}/check-out-1.jpg` });
    const je = prisma.jobEvent.create.mock.calls[0][0].data;
    expect(je.note).toBe('งานเรียบร้อย');
    expect(je.photoUrl).toBe(`${BOOKING_ID}/check-out-1.jpg`); // bucket stripped, path stored
  });

  it('TC_13 out_of_radius (from check-in) + short_duration → BOTH present, appended, needs_review', async () => {
    // check-in already flagged out_of_radius (stored on booking.reviewReasons); check out short
    const { svc, prisma } = makeService(
      fakeBooking({ reviewReasons: ['out_of_radius'] }),
      nowPlus(120),
    );
    await checkOut(svc);
    const upd = prisma.booking.update.mock.calls[0][0].data;
    expect(upd.reviewReasons.set).toEqual(
      expect.arrayContaining(['out_of_radius', 'short_duration']),
    );
    expect(upd.reviewReasons.set).toHaveLength(2); // appended, not overwritten
    expect(upd.status).toBe('needs_review');
  });
});

// ── Sweeper cases (TC_09/10/14) — verified against dev after PYG-359 (PR #28) merged ──
import { NoCheckoutSweeperService } from './no-checkout-sweeper.service';
import { PayoutEligibilityService } from '../payout/payout-eligibility.service';
import { VERDICT } from './monitoring.constants';

describe('PYG-363 Check-out — sweeper (PYG-359, now on dev)', () => {
  const SWEEP_BOOKING = {
    id: 'bk-sweep',
    caregiverId: CAREGIVER_ID,
    bookingDate: new Date('2026-08-20T00:00:00.000Z'),
    startTime: new Date('1970-01-01T09:00:00.000Z'), // 09:00 ICT, 3h → end 12:00 ICT = 05:00Z
    durationHours: 3,
    reviewReasons: [] as string[],
    caregiver: { userId: 'cg-user-1' },
  };
  const DUE_NOW = '2026-08-20T12:00:00.000Z'; // end 05:00Z + 6h cutoff = 11:00Z → due

  function makeSweeper() {
    const prisma = {
      booking: { findMany: jest.fn().mockResolvedValue([SWEEP_BOOKING]), update: jest.fn() },
      jobEvent: { create: jest.fn() },
      user: { findMany: jest.fn().mockResolvedValue([{ id: 'admin-1' }]) },
      $transaction: jest.fn().mockResolvedValue([{}, {}]),
    };
    const clock = { now: () => new Date(DUE_NOW) };
    const notifications = { create: jest.fn().mockResolvedValue({}) };
    const svc = new NoCheckoutSweeperService(prisma as never, clock as never, notifications as never);
    return { svc, prisma };
  }

  it('TC_09 sweeper → SYSTEM check_out (NULL coords, no duration), no_checkout, needs_review, no money touched', async () => {
    const { svc, prisma } = makeSweeper();
    await svc.run();
    const je = prisma.jobEvent.create.mock.calls[0][0].data;
    expect(je.source).toBe('system');
    expect(je.lat).toBeNull();
    expect(je.lng).toBeNull();
    expect(je.distanceM).toBeNull();
    expect(je).not.toHaveProperty('actualDuration');
    const upd = prisma.booking.update.mock.calls[0][0].data;
    expect(upd.status).toBe('needs_review');
    expect(upd.reviewReasons).toEqual({ set: ['no_checkout'] });
    expect(prisma).not.toHaveProperty('payment'); // sweeper never touches payment
  });

  it('TC_10 release gate: PayoutEligibility does NOT release a swept (needs_review) booking', () => {
    const elig = new PayoutEligibilityService({} as never, {} as never);
    const proof = {
      checkIn: { id: 'ci' }, checkOut: { id: 'co', source: 'system' },
      verdict: VERDICT.NEEDS_REVIEW, reviewReasons: ['no_checkout'],
      noCheckout: true, disputed: false,
    };
    const res = elig.evaluate(proof as never, { refundedAmount: 0 } as never);
    expect(res.kind).not.toBe('eligible'); // no Omise transfer; payment stays held
    expect(res.kind).toBe('hold');
  });

  it('TC_14 verdict differs by source: caregiver → valid, system → needs_review', () => {
    const m: MonitoringServiceT = new MonitoringService(
      {} as never, {} as never, {} as never, {} as never, {} as never,
    );
    expect(m.computeVerdict([], true, 'caregiver', 'none')).toBe(VERDICT.VALID);
    expect(m.computeVerdict([], true, 'system', 'none')).toBe(VERDICT.NEEDS_REVIEW);
  });
});
