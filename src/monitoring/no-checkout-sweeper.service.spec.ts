/**
 * PYG-359 — No-checkout sweeper tests.
 *
 * Proves the money-safety heart: a swept booking gets a SYSTEM check_out row + 'no_checkout'
 * flag + status needs_review, payment untouched, and BOTH independent layers block release on
 * their own. Idempotent, tz-correct end_ts, notifies caregiver + admin. No money moved.
 */
import { Prisma } from '@prisma/client';
import { NoCheckoutSweeperService } from './no-checkout-sweeper.service';
import { MonitoringService } from './monitoring.service';
import { PayoutEligibilityService } from '../payout/payout-eligibility.service';
import { VERDICT } from './monitoring.constants';

const CAREGIVER_ID = 'cg-1';
const CAREGIVER_USER = 'cg-user-1';
const BOOKING_ID = 'bk-1';

/** in_progress booking, checked-in, no checkout. start 09:00 ICT, 3h → end 12:00 ICT = 05:00Z. */
function candidate(over: Record<string, unknown> = {}) {
  return {
    id: BOOKING_ID,
    caregiverId: CAREGIVER_ID,
    bookingDate: new Date('2026-08-20T00:00:00.000Z'),
    startTime: new Date('1970-01-01T09:00:00.000Z'), // UTC-hours read as ICT wall-clock
    durationHours: 3,
    reviewReasons: [] as string[],
    caregiver: { userId: CAREGIVER_USER },
    ...over,
  };
}

function makeSweeper(candidates: unknown[], nowIso: string) {
  const prisma = {
    booking: { findMany: jest.fn().mockResolvedValue(candidates), update: jest.fn() },
    jobEvent: { create: jest.fn() },
    user: { findMany: jest.fn().mockResolvedValue([{ id: 'admin-1' }, { id: 'admin-2' }]) },
    $transaction: jest.fn().mockResolvedValue([{}, {}]),
  };
  const clock = { now: () => new Date(nowIso) };
  const notifications = { create: jest.fn().mockResolvedValue({}) };
  const svc = new NoCheckoutSweeperService(
    prisma as never, clock as never, notifications as never,
  );
  return { svc, prisma, notifications };
}

// end_ts = 05:00Z; +6h sweep cutoff = 11:00Z
const DUE_NOW = '2026-08-20T11:30:00.000Z'; // past cutoff → sweep
const NOT_DUE_NOW = '2026-08-20T10:00:00.000Z'; // before cutoff → skip

describe('PYG-359 no-checkout sweeper', () => {
  it('due booking → SYSTEM check_out row (lat/lng/distance NULL, no duration), needs_review, payment untouched', async () => {
    const { svc, prisma } = makeSweeper([candidate()], DUE_NOW);
    await svc.run();

    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    const je = prisma.jobEvent.create.mock.calls[0][0].data;
    expect(je.source).toBe('system'); // Layer 1
    expect(je.eventType).toBe('check_out');
    expect(je.lat).toBeNull();
    expect(je.lng).toBeNull();
    expect(je.distanceM).toBeNull(); // no guessed position
    expect(je).not.toHaveProperty('actualDuration'); // no duration computed
    expect(je.note).toBe('system: no checkout');

    const upd = prisma.booking.update.mock.calls[0][0].data;
    expect(upd.status).toBe('needs_review'); // NOT awaiting_release
    expect(upd.reviewReasons).toEqual({ set: ['no_checkout'] }); // Layer 2

    // sweeper never touches payment — no payment model call exists on the mock at all
    expect(prisma).not.toHaveProperty('payment');
  });

  it('not-yet-due (before end_ts + 6h) → skipped, nothing written', async () => {
    const { svc, prisma } = makeSweeper([candidate()], NOT_DUE_NOW);
    await svc.run();
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(prisma.jobEvent.create).not.toHaveBeenCalled();
  });

  it('append, never overwrite — existing flags preserved alongside no_checkout', async () => {
    const { svc, prisma } = makeSweeper(
      [candidate({ reviewReasons: ['out_of_radius'] })],
      DUE_NOW,
    );
    await svc.run();
    const upd = prisma.booking.update.mock.calls[0][0].data;
    expect(upd.reviewReasons.set).toEqual(
      expect.arrayContaining(['out_of_radius', 'no_checkout']),
    );
    expect(upd.reviewReasons.set).toHaveLength(2);
  });

  it('idempotent — a racing check_out (P2002) is caught, no throw, no crash', async () => {
    const { svc, prisma } = makeSweeper([candidate()], DUE_NOW);
    prisma.$transaction.mockRejectedValueOnce(
      new Prisma.PrismaClientKnownRequestError('unique', { code: 'P2002', clientVersion: 't' }),
    );
    await expect(svc.run()).resolves.toBeUndefined(); // swallowed, run completes
  });

  it('notifies caregiver + both admins, never the patient', async () => {
    const { svc, notifications } = makeSweeper([candidate()], DUE_NOW);
    await svc.run();
    const recipients = notifications.create.mock.calls.map((c: unknown[]) => c[0]);
    expect(recipients).toContain(CAREGIVER_USER);
    expect(recipients).toContain('admin-1');
    expect(recipients).toContain('admin-2');
    expect(recipients).toHaveLength(3); // caregiver + 2 admins, no patient
  });

  it('tz-correct end_ts — 05:00Z + 6h boundary; 10:59Z not due, 11:01Z due', async () => {
    const before = makeSweeper([candidate()], '2026-08-20T10:59:00.000Z');
    await before.svc.run();
    expect(before.prisma.$transaction).not.toHaveBeenCalled();

    const after = makeSweeper([candidate()], '2026-08-20T11:01:00.000Z');
    await after.svc.run();
    expect(after.prisma.$transaction).toHaveBeenCalledTimes(1);
  });
});

describe('PYG-359 — two independent safety layers (money cannot escape)', () => {
  const verdictSvc = () =>
    new MonitoringService({} as never, {} as never, {} as never, {} as never, {} as never);

  it('Layer 1 alone: source=system blocks release EVEN with no_checkout removed', () => {
    // reviewReasons empty (Layer 2 disabled) but source=system → still needs_review
    const v = verdictSvc().computeVerdict([], true, 'system', 'none');
    expect(v).toBe(VERDICT.NEEDS_REVIEW);
    expect(v).not.toBe(VERDICT.VALID);
  });

  it('Layer 2 alone: no_checkout flag blocks release EVEN if source were caregiver', () => {
    // source caregiver (Layer 1 disabled) but reasons=[no_checkout] → still needs_review
    const v = verdictSvc().computeVerdict(['no_checkout'], true, 'caregiver', 'none');
    expect(v).toBe(VERDICT.NEEDS_REVIEW);
  });

  it('both layers present → needs_review', () => {
    expect(verdictSvc().computeVerdict(['no_checkout'], true, 'system', 'none')).toBe(
      VERDICT.NEEDS_REVIEW,
    );
  });

  it('release gate: PayoutEligibility does NOT release a needs_review booking (payment stays held)', () => {
    const elig = new PayoutEligibilityService({} as never, {} as never);
    const proof = {
      checkIn: { id: 'ci' }, checkOut: { id: 'co' },
      verdict: VERDICT.NEEDS_REVIEW, reviewReasons: ['no_checkout'],
      noCheckout: true, disputed: false,
    };
    const res = elig.evaluate(proof as never, { refundedAmount: 0 } as never);
    expect(res.kind).not.toBe('eligible'); // → hold, no Omise transfer
    expect(res.kind).toBe('hold');
  });
});
