/**
 * PayoutService tests (PYG-330 ก้อน B — create side)
 *
 * ครอบคลุม:
 * - guard: caregiverId null → skip (ไม่ INSERT)
 * - guard: no payment → skip
 * - guard: completedAt ก่อน cutoff → skip
 * - fee math: gross=1000, rate=0.10 → platformFee=100, amount=900, invariant ผ่าน
 * - fee math (rounding trap): gross=333.33 → HALF_UP
 * - fee_rate snapshot: insert ตอน env=0.10 → env เปลี่ยนเป็น 0.15 → row เดิมยัง 0.1000
 * - scheduled_at: completed_at + 7 * 24h (timezone-agnostic, absolute time)
 * - idempotency: unique violation P2002 → log + return (ไม่ throw)
 */
import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '@prisma/client';
import { PayoutService } from './payout.service';
import { PrismaService } from '../common/prisma.service';

// ── Helpers ────────────────────────────────────────────────────────────────

const BOOKING_ID = 'booking-1';
const CAREGIVER_ID = 'cg-profile-1';

function makeConfig(overrides: Record<string, string> = {}) {
  const values: Record<string, string> = {
    PAYOUT_PLATFORM_FEE_RATE: '0.10',
    PAYOUT_HOLD_WINDOW_DAYS: '7',
    PAYOUT_START_FROM: '2026-07-18T00:00:00+07:00',
    ...overrides,
  };
  return {
    getOrThrow: jest.fn((key: string) => {
      const v = values[key];
      if (v === undefined) throw new Error(`missing ${key}`);
      return v;
    }),
  };
}

function makeBooking(overrides: Record<string, unknown> = {}) {
  return {
    id: BOOKING_ID,
    caregiverId: CAREGIVER_ID,
    // ใช้ Date UTC absolute — บ้าน CI จะเป็น UTC แต่ code timezone-agnostic
    completedAt: new Date('2026-08-01T10:00:00Z'),
    payment: {
      id: 'pay-1',
      amount: new Prisma.Decimal('1000.00'),
    },
    ...overrides,
  };
}

// ── Test suite ─────────────────────────────────────────────────────────────

describe('PayoutService', () => {
  let service: PayoutService;
  let prisma: {
    booking: { findUnique: jest.Mock };
    payout: { create: jest.Mock };
  };
  let config: ReturnType<typeof makeConfig>;

  beforeEach(async () => {
    prisma = {
      booking: { findUnique: jest.fn() },
      payout: { create: jest.fn() },
    };
    config = makeConfig();

    const moduleRef: TestingModule = await Test.createTestingModule({
      providers: [
        PayoutService,
        { provide: PrismaService, useValue: prisma },
        { provide: ConfigService, useValue: config },
      ],
    }).compile();

    service = moduleRef.get(PayoutService);
  });

  // ── Guards ────────────────────────────────────────────────────────────────

  it('booking not found → skip, no INSERT', async () => {
    prisma.booking.findUnique.mockResolvedValue(null);
    await service.createFromCompletedBooking(BOOKING_ID);
    expect(prisma.payout.create).not.toHaveBeenCalled();
  });

  it('caregiverId null → skip', async () => {
    prisma.booking.findUnique.mockResolvedValue(
      makeBooking({ caregiverId: null }),
    );
    await service.createFromCompletedBooking(BOOKING_ID);
    expect(prisma.payout.create).not.toHaveBeenCalled();
  });

  it('no payment row → skip', async () => {
    prisma.booking.findUnique.mockResolvedValue(
      makeBooking({ payment: null }),
    );
    await service.createFromCompletedBooking(BOOKING_ID);
    expect(prisma.payout.create).not.toHaveBeenCalled();
  });

  it('completedAt before PAYOUT_START_FROM → skip', async () => {
    // cutoff = 2026-07-18T00:00:00+07:00 = 2026-07-17T17:00:00Z (UTC)
    // booking completed at 2026-07-10 → ก่อน cutoff
    prisma.booking.findUnique.mockResolvedValue(
      makeBooking({ completedAt: new Date('2026-07-10T10:00:00Z') }),
    );
    await service.createFromCompletedBooking(BOOKING_ID);
    expect(prisma.payout.create).not.toHaveBeenCalled();
  });

  // ── Fee math ─────────────────────────────────────────────────────────────

  it('gross=1000, rate=0.10 → platformFee=100.00, amount=900.00', async () => {
    prisma.booking.findUnique.mockResolvedValue(makeBooking());
    prisma.payout.create.mockResolvedValue({ id: 'p1' });

    await service.createFromCompletedBooking(BOOKING_ID);

    expect(prisma.payout.create).toHaveBeenCalledTimes(1);
    const args = prisma.payout.create.mock.calls[0][0];
    expect(args.data.grossAmount.toString()).toBe('1000');
    expect(args.data.feeRate.toString()).toBe('0.1');
    expect(args.data.platformFee.toString()).toBe('100');
    expect(args.data.amount.toString()).toBe('900');

    // Invariant: gross = fee + amount
    const gross = args.data.grossAmount as Prisma.Decimal;
    const fee = args.data.platformFee as Prisma.Decimal;
    const net = args.data.amount as Prisma.Decimal;
    expect(fee.add(net).equals(gross)).toBe(true);
  });

  it('HALF_UP rounding — gross=333.33, rate=0.10 → fee=33.33, amount=300.00', async () => {
    prisma.booking.findUnique.mockResolvedValue(
      makeBooking({
        payment: { id: 'pay-1', amount: new Prisma.Decimal('333.33') },
      }),
    );
    prisma.payout.create.mockResolvedValue({ id: 'p1' });

    await service.createFromCompletedBooking(BOOKING_ID);

    const args = prisma.payout.create.mock.calls[0][0];
    // 333.33 * 0.10 = 33.333 → HALF_UP 2dp → 33.33
    expect(args.data.platformFee.toString()).toBe('33.33');
    // amount = 333.33 - 33.33 = 300.00
    expect(args.data.amount.toString()).toBe('300');

    const gross = args.data.grossAmount as Prisma.Decimal;
    const fee = args.data.platformFee as Prisma.Decimal;
    const net = args.data.amount as Prisma.Decimal;
    expect(fee.add(net).equals(gross)).toBe(true);
  });

  it('HALF_UP rounding — 0.005 rounds UP (not banker rounding)', async () => {
    // gross=0.05, rate=0.10 → 0.005 exactly → HALF_UP → 0.01
    prisma.booking.findUnique.mockResolvedValue(
      makeBooking({
        payment: { id: 'pay-1', amount: new Prisma.Decimal('0.05') },
      }),
    );
    prisma.payout.create.mockResolvedValue({ id: 'p1' });

    await service.createFromCompletedBooking(BOOKING_ID);

    const args = prisma.payout.create.mock.calls[0][0];
    expect(args.data.platformFee.toString()).toBe('0.01');
    expect(args.data.amount.toString()).toBe('0.04');
  });

  // ── Snapshot (Sam's requirement) ──────────────────────────────────────────

  it('fee_rate snapshot: insert @0.10 → env changes to 0.15 → next insert uses 0.15; the returned data is unchanged for the earlier row', async () => {
    // First insert with rate=0.10
    prisma.booking.findUnique.mockResolvedValue(makeBooking());
    prisma.payout.create.mockResolvedValue({ id: 'p1' });
    await service.createFromCompletedBooking(BOOKING_ID);
    const firstArgs = prisma.payout.create.mock.calls[0][0];
    expect(firstArgs.data.feeRate.toString()).toBe('0.1');

    // Config change — simulate env update
    config.getOrThrow.mockImplementation((key: string) => {
      if (key === 'PAYOUT_PLATFORM_FEE_RATE') return '0.15';
      if (key === 'PAYOUT_HOLD_WINDOW_DAYS') return '7';
      if (key === 'PAYOUT_START_FROM') return '2026-07-18T00:00:00+07:00';
      throw new Error('missing');
    });

    // Second insert (different booking) — sees new rate
    prisma.booking.findUnique.mockResolvedValue(
      makeBooking({ id: 'booking-2' }),
    );
    prisma.payout.create.mockResolvedValue({ id: 'p2' });
    await service.createFromCompletedBooking('booking-2');

    const secondArgs = prisma.payout.create.mock.calls[1][0];
    expect(secondArgs.data.feeRate.toString()).toBe('0.15');
    // gross=1000 * 0.15 = 150.00
    expect(secondArgs.data.platformFee.toString()).toBe('150');
    expect(secondArgs.data.amount.toString()).toBe('850');

    // ⚠️ Row #1's snapshot ยังคงเดิม (0.1) — ตรวจซ้ำจาก call log
    expect(firstArgs.data.feeRate.toString()).toBe('0.1');
    expect(firstArgs.data.platformFee.toString()).toBe('100');
  });

  // ── scheduled_at + timezone ───────────────────────────────────────────────

  it('scheduled_at = completed_at + 7 days (absolute time, tz-agnostic)', async () => {
    const completedAt = new Date('2026-08-01T10:00:00Z');
    prisma.booking.findUnique.mockResolvedValue(makeBooking({ completedAt }));
    prisma.payout.create.mockResolvedValue({ id: 'p1' });

    await service.createFromCompletedBooking(BOOKING_ID);

    const args = prisma.payout.create.mock.calls[0][0];
    const scheduled = args.data.scheduledAt as Date;

    // exactly 7 * 24 hours later
    expect(scheduled.getTime() - completedAt.getTime()).toBe(
      7 * 24 * 60 * 60 * 1000,
    );
    // absolute value: 2026-08-08T10:00:00Z
    expect(scheduled.toISOString()).toBe('2026-08-08T10:00:00.000Z');
  });

  it('timezone spot check: completed_at at Bangkok midnight → scheduled 7d later same wall-clock', async () => {
    // 2026-08-01T00:00:00+07:00 = 2026-07-31T17:00:00Z (UTC)
    const completedAt = new Date('2026-08-01T00:00:00+07:00');
    prisma.booking.findUnique.mockResolvedValue(makeBooking({ completedAt }));
    prisma.payout.create.mockResolvedValue({ id: 'p1' });

    await service.createFromCompletedBooking(BOOKING_ID);

    const args = prisma.payout.create.mock.calls[0][0];
    const scheduled = args.data.scheduledAt as Date;

    // +7d = 2026-08-08T00:00:00+07:00 = 2026-08-07T17:00:00Z
    expect(scheduled.toISOString()).toBe('2026-08-07T17:00:00.000Z');
  });

  // ── Idempotency ──────────────────────────────────────────────────────────

  it('P2002 unique violation on booking_id → log + return (no throw, no second row)', async () => {
    prisma.booking.findUnique.mockResolvedValue(makeBooking());
    prisma.payout.create.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError('duplicate', {
        code: 'P2002',
        clientVersion: 'x',
      }),
    );

    // ต้องไม่ throw — event listener จะได้ไม่พัง
    await expect(
      service.createFromCompletedBooking(BOOKING_ID),
    ).resolves.toBeUndefined();

    expect(prisma.payout.create).toHaveBeenCalledTimes(1);
  });

  it('unknown error → log + return (no throw)', async () => {
    prisma.booking.findUnique.mockResolvedValue(makeBooking());
    prisma.payout.create.mockRejectedValue(new Error('connection lost'));

    await expect(
      service.createFromCompletedBooking(BOOKING_ID),
    ).resolves.toBeUndefined();
  });
});
