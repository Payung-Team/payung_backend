/**
 * PayoutService tests (PYG-330 + PYG-331 ก้อน B)
 *
 * โครง 330 เดิมยังใช้ได้ — เพิ่ม state machine provider + $transaction wrap
 * ตอนสร้าง (payout.create + recordInitialStatus ต้อง atomic)
 *
 * ครอบคลุม:
 * - guard: caregiverId null / no payment / before cutoff → skip
 * - fee math: gross=1000 rate=0.10, HALF_UP 33.33, HALF_UP 0.005
 * - fee_rate snapshot immutability
 * - scheduled_at absolute-time + timezone spot check
 * - idempotency: P2002 caught (no throw)
 * - unknown error swallowed
 * - PYG-331 additions:
 *   - payout.create + recordInitialStatus อยู่ tx เดียวกัน
 *   - recordInitialStatus ถูกเรียกด้วย from=null, to=scheduled
 */
import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '@prisma/client';
import { PayoutService } from './payout.service';
import { PrismaService } from '../common/prisma.service';
import { PayoutStateMachine } from './payout-state-machine';
import { PayoutStatus } from './entities/payout-status.enum';
import { PayoutEligibilityService } from './payout-eligibility.service';

const BOOKING_ID = 'booking-1';
const CAREGIVER_ID = 'cg-profile-1';
const CREATED_PAYOUT_ID = 'payout-created-1';

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
    completedAt: new Date('2026-08-01T10:00:00Z'),
    payment: { id: 'pay-1', amount: new Prisma.Decimal('1000.00') },
    ...overrides,
  };
}

/** verdict ที่ payout gate คืนมา — กฎจริงเทสต์แยกใน payout-eligibility.service.spec */
function eligibleVerdict() {
  return {
    kind: 'eligible' as const,
    reason: 'proof_valid',
    evidence: {
      checkInId: 'evt-in-1',
      checkOutId: 'evt-out-1',
      verdict: 'valid',
      reviewReasons: [],
      noCheckout: false,
      disputed: false,
      refundedAmount: 0,
    },
  };
}

describe('PayoutService', () => {
  let service: PayoutService;
  let tx: { payout: { create: jest.Mock } };
  let prisma: {
    booking: { findUnique: jest.Mock };
    payout: { create: jest.Mock };
    $transaction: jest.Mock;
  };
  let stateMachine: { recordInitialStatus: jest.Mock };
  let config: ReturnType<typeof makeConfig>;
  let eligibility: { check: jest.Mock };

  beforeEach(async () => {
    tx = { payout: { create: jest.fn() } };
    prisma = {
      booking: { findUnique: jest.fn() },
      payout: { create: jest.fn() },
      $transaction: jest.fn(async (cb: (t: typeof tx) => unknown) => cb(tx)),
    };
    stateMachine = { recordInitialStatus: jest.fn().mockResolvedValue(undefined) };
    config = makeConfig();
    // default: หลักฐานครบ verdict=valid (เทสต์ที่สนใจ gate จะ override เอง)
    eligibility = { check: jest.fn().mockResolvedValue(eligibleVerdict()) };

    const mod: TestingModule = await Test.createTestingModule({
      providers: [
        PayoutService,
        { provide: PrismaService, useValue: prisma },
        { provide: ConfigService, useValue: config },
        { provide: PayoutStateMachine, useValue: stateMachine },
        { provide: PayoutEligibilityService, useValue: eligibility },
      ],
    }).compile();

    service = mod.get(PayoutService);
  });

  // ── Guards ────────────────────────────────────────────────────────────────

  it('booking not found → skip', async () => {
    prisma.booking.findUnique.mockResolvedValue(null);
    await service.createFromCompletedBooking(BOOKING_ID);
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(stateMachine.recordInitialStatus).not.toHaveBeenCalled();
  });

  it('caregiverId null → skip', async () => {
    prisma.booking.findUnique.mockResolvedValue(
      makeBooking({ caregiverId: null }),
    );
    await service.createFromCompletedBooking(BOOKING_ID);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('no payment row → skip', async () => {
    prisma.booking.findUnique.mockResolvedValue(makeBooking({ payment: null }));
    await service.createFromCompletedBooking(BOOKING_ID);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('completedAt before cutoff → skip', async () => {
    prisma.booking.findUnique.mockResolvedValue(
      makeBooking({ completedAt: new Date('2026-07-10T10:00:00Z') }),
    );
    await service.createFromCompletedBooking(BOOKING_ID);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  // ── Payout gate (ห้ามสร้าง payout ให้ booking ที่ไม่ควรได้เงิน) ─────────────

  it("verdict ไม่ใช่ 'valid' → ไม่สร้าง payout row เลย", async () => {
    prisma.booking.findUnique.mockResolvedValue(makeBooking());
    eligibility.check.mockResolvedValue({
      kind: 'hold',
      reason: 'proof_needs_review',
      evidence: { verdict: 'needs_review' },
    });

    await service.createFromCompletedBooking(BOOKING_ID);

    // ไม่ใช่ "สร้างแล้ว mark failed" — ต้องไม่มีแถวเกิดขึ้นเลย
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(tx.payout.create).not.toHaveBeenCalled();
    expect(stateMachine.recordInitialStatus).not.toHaveBeenCalled();
  });

  it('งานที่ไม่มีเช็คเอาท์ (no_checkout) → ไม่สร้าง payout', async () => {
    prisma.booking.findUnique.mockResolvedValue(makeBooking());
    eligibility.check.mockResolvedValue({
      kind: 'hold',
      reason: 'proof_no_checkout',
      evidence: { verdict: 'incomplete', noCheckout: true },
    });

    await service.createFromCompletedBooking(BOOKING_ID);

    expect(tx.payout.create).not.toHaveBeenCalled();
  });

  it('booking ที่มีข้อพิพาทเปิดอยู่ → ไม่สร้าง payout', async () => {
    prisma.booking.findUnique.mockResolvedValue(makeBooking());
    eligibility.check.mockResolvedValue({
      kind: 'hold',
      reason: 'proof_needs_review',
      evidence: { verdict: 'needs_review', disputed: true },
    });

    await service.createFromCompletedBooking(BOOKING_ID);

    expect(tx.payout.create).not.toHaveBeenCalled();
  });

  it('deny (คืนเงินไปแล้ว) → ไม่สร้าง payout', async () => {
    prisma.booking.findUnique.mockResolvedValue(makeBooking());
    eligibility.check.mockResolvedValue({
      kind: 'deny',
      reason: 'payment_refunded',
      evidence: { refundedAmount: 1000 },
    });

    await service.createFromCompletedBooking(BOOKING_ID);

    expect(tx.payout.create).not.toHaveBeenCalled();
  });

  it('gate ไม่ throw ออกไปหา listener (listener swallow → จะกลายเป็นล้มเงียบ)', async () => {
    prisma.booking.findUnique.mockResolvedValue(makeBooking());
    eligibility.check.mockResolvedValue({
      kind: 'hold',
      reason: 'proof_needs_review',
      evidence: {},
    });

    await expect(
      service.createFromCompletedBooking(BOOKING_ID),
    ).resolves.toBeUndefined();
  });

  it('payout ที่สร้างสำเร็จ แนบ checkInId/checkOutId/verdict ลง history metadata', async () => {
    prisma.booking.findUnique.mockResolvedValue(makeBooking());
    tx.payout.create.mockResolvedValue({ id: CREATED_PAYOUT_ID });

    await service.createFromCompletedBooking(BOOKING_ID);

    const [, , options] = stateMachine.recordInitialStatus.mock.calls[0];
    expect(options.metadata).toEqual(
      expect.objectContaining({
        gate: 'proof_valid',
        checkInId: 'evt-in-1',
        checkOutId: 'evt-out-1',
        verdict: 'valid',
      }),
    );
  });

  // ── Fee math ─────────────────────────────────────────────────────────────

  it('gross=1000, rate=0.10 → platformFee=100, amount=900', async () => {
    prisma.booking.findUnique.mockResolvedValue(makeBooking());
    tx.payout.create.mockResolvedValue({ id: CREATED_PAYOUT_ID });

    await service.createFromCompletedBooking(BOOKING_ID);

    expect(tx.payout.create).toHaveBeenCalledTimes(1);
    const args = tx.payout.create.mock.calls[0][0];
    expect(args.data.grossAmount.toString()).toBe('1000');
    expect(args.data.feeRate.toString()).toBe('0.1');
    expect(args.data.platformFee.toString()).toBe('100');
    expect(args.data.amount.toString()).toBe('900');
    // invariant
    const gross = args.data.grossAmount as Prisma.Decimal;
    const fee = args.data.platformFee as Prisma.Decimal;
    const net = args.data.amount as Prisma.Decimal;
    expect(fee.add(net).equals(gross)).toBe(true);
  });

  it('HALF_UP — gross=333.33 → fee=33.33 net=300', async () => {
    prisma.booking.findUnique.mockResolvedValue(
      makeBooking({
        payment: { id: 'pay-1', amount: new Prisma.Decimal('333.33') },
      }),
    );
    tx.payout.create.mockResolvedValue({ id: CREATED_PAYOUT_ID });
    await service.createFromCompletedBooking(BOOKING_ID);

    const args = tx.payout.create.mock.calls[0][0];
    expect(args.data.platformFee.toString()).toBe('33.33');
    expect(args.data.amount.toString()).toBe('300');
  });

  it('HALF_UP — 0.005 rounds up to 0.01 (banker rounding would be 0.00)', async () => {
    prisma.booking.findUnique.mockResolvedValue(
      makeBooking({
        payment: { id: 'pay-1', amount: new Prisma.Decimal('0.05') },
      }),
    );
    tx.payout.create.mockResolvedValue({ id: CREATED_PAYOUT_ID });
    await service.createFromCompletedBooking(BOOKING_ID);

    const args = tx.payout.create.mock.calls[0][0];
    expect(args.data.platformFee.toString()).toBe('0.01');
    expect(args.data.amount.toString()).toBe('0.04');
  });

  // ── Snapshot ─────────────────────────────────────────────────────────────

  it('fee_rate snapshot immutability: env change does not affect earlier row', async () => {
    prisma.booking.findUnique.mockResolvedValue(makeBooking());
    tx.payout.create.mockResolvedValue({ id: 'p-1' });
    await service.createFromCompletedBooking(BOOKING_ID);
    const firstArgs = tx.payout.create.mock.calls[0][0];
    expect(firstArgs.data.feeRate.toString()).toBe('0.1');

    // env change
    config.getOrThrow.mockImplementation((key: string) => {
      if (key === 'PAYOUT_PLATFORM_FEE_RATE') return '0.15';
      if (key === 'PAYOUT_HOLD_WINDOW_DAYS') return '7';
      if (key === 'PAYOUT_START_FROM') return '2026-07-18T00:00:00+07:00';
      throw new Error('missing');
    });
    prisma.booking.findUnique.mockResolvedValue(
      makeBooking({ id: 'booking-2' }),
    );
    tx.payout.create.mockResolvedValue({ id: 'p-2' });
    await service.createFromCompletedBooking('booking-2');
    const secondArgs = tx.payout.create.mock.calls[1][0];
    expect(secondArgs.data.feeRate.toString()).toBe('0.15');

    // first row snapshot ยังคงเดิม
    expect(firstArgs.data.feeRate.toString()).toBe('0.1');
    expect(firstArgs.data.platformFee.toString()).toBe('100');
  });

  // ── scheduled_at ──────────────────────────────────────────────────────────

  it('scheduled_at = completed_at + 7d absolute', async () => {
    const completedAt = new Date('2026-08-01T10:00:00Z');
    prisma.booking.findUnique.mockResolvedValue(makeBooking({ completedAt }));
    tx.payout.create.mockResolvedValue({ id: 'p-1' });
    await service.createFromCompletedBooking(BOOKING_ID);

    const args = tx.payout.create.mock.calls[0][0];
    expect(args.data.scheduledAt.toISOString()).toBe(
      '2026-08-08T10:00:00.000Z',
    );
  });

  it('scheduled_at tz spot check', async () => {
    const completedAt = new Date('2026-08-01T00:00:00+07:00');
    prisma.booking.findUnique.mockResolvedValue(makeBooking({ completedAt }));
    tx.payout.create.mockResolvedValue({ id: 'p-1' });
    await service.createFromCompletedBooking(BOOKING_ID);

    const args = tx.payout.create.mock.calls[0][0];
    // +7d = 2026-08-08T00:00:00+07:00 = 2026-08-07T17:00:00Z
    expect(args.data.scheduledAt.toISOString()).toBe(
      '2026-08-07T17:00:00.000Z',
    );
  });

  // ── PYG-331: atomic tx + recordInitialStatus ─────────────────────────────

  it('wraps create + recordInitialStatus in single $transaction', async () => {
    prisma.booking.findUnique.mockResolvedValue(makeBooking());
    tx.payout.create.mockResolvedValue({ id: CREATED_PAYOUT_ID });

    await service.createFromCompletedBooking(BOOKING_ID);

    // $transaction wrapper used
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    // recordInitialStatus received the tx client (not root prisma)
    expect(stateMachine.recordInitialStatus).toHaveBeenCalledWith(
      CREATED_PAYOUT_ID,
      PayoutStatus.scheduled,
      expect.objectContaining({ reason: 'created_from_booking_completed' }),
      tx,
    );
  });

  // ── Idempotency ──────────────────────────────────────────────────────────

  it('P2002 (unique on booking_id) → log + return, no throw', async () => {
    prisma.booking.findUnique.mockResolvedValue(makeBooking());
    tx.payout.create.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError('dup', {
        code: 'P2002',
        clientVersion: 'x',
      }),
    );

    await expect(
      service.createFromCompletedBooking(BOOKING_ID),
    ).resolves.toBeUndefined();
  });

  it('unknown error → log + return, no throw', async () => {
    prisma.booking.findUnique.mockResolvedValue(makeBooking());
    tx.payout.create.mockRejectedValue(new Error('DB down'));

    await expect(
      service.createFromCompletedBooking(BOOKING_ID),
    ).resolves.toBeUndefined();
  });
});
