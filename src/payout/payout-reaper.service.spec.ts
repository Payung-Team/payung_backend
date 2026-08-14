/**
 * PayoutReaperService tests (PYG-331 ก้อน B)
 */
import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { PayoutReaperService } from './payout-reaper.service';
import { PrismaService } from '../common/prisma.service';
import { PayoutStateMachine } from './payout-state-machine';
import { PayoutStatus } from './entities/payout-status.enum';
import { InvalidPayoutTransitionError } from './errors/invalid-payout-transition.error';
import { PayoutRetryPolicy } from './payout-retry-policy';
import { PayoutKillswitch } from './payout-killswitch';
import { PayoutEligibilityService } from './payout-eligibility.service';

const PAYOUT_ID = 'payout-1';

function makePayout(overrides: Record<string, unknown> = {}) {
  return {
    id: PAYOUT_ID,
    status: PayoutStatus.processing,
    retryCount: 0,
    updatedAt: new Date('2026-08-01T09:00:00Z'), // 1 hour ago from test 'now'
    ...overrides,
  };
}

describe('PayoutReaperService', () => {
  let reaper: PayoutReaperService;
  let prisma: {
    payout: { findMany: jest.Mock };
    $transaction: jest.Mock;
  };
  let stateMachine: { transition: jest.Mock; claim: jest.Mock };
  let retryPolicy: { decide: jest.Mock };
  let killswitch: { gate: jest.Mock };
  let config: { getOrThrow: jest.Mock };
  let eligibility: { check: jest.Mock };

  beforeEach(async () => {
    prisma = {
      payout: { findMany: jest.fn() },
      $transaction: jest.fn(async (cb: (t: unknown) => Promise<unknown>) =>
        cb({}),
      ),
    };
    stateMachine = {
      transition: jest.fn().mockResolvedValue({}),
      claim: jest.fn().mockResolvedValue({ claimed: true, payout: {} }),
    };
    retryPolicy = { decide: jest.fn() };
    killswitch = { gate: jest.fn().mockReturnValue(false) };
    // default: ทุก booking ยังจ่ายได้ → eligibility sweep ไม่ทำอะไร
    eligibility = {
      check: jest
        .fn()
        .mockResolvedValue({
          kind: 'eligible',
          reason: 'no_dispute',
          evidence: {},
        }),
    };
    config = {
      getOrThrow: jest.fn(
        (k: string) =>
          ({ PAYOUT_STALE_PROCESSING_MINUTES: '30' })[k] ??
          (() => {
            throw new Error(`missing ${k}`);
          })(),
      ),
    };

    const mod: TestingModule = await Test.createTestingModule({
      providers: [
        PayoutReaperService,
        { provide: PrismaService, useValue: prisma },
        { provide: ConfigService, useValue: config },
        { provide: PayoutStateMachine, useValue: stateMachine },
        { provide: PayoutRetryPolicy, useValue: retryPolicy },
        { provide: PayoutKillswitch, useValue: killswitch },
        { provide: PayoutEligibilityService, useValue: eligibility },
      ],
    }).compile();

    reaper = mod.get(PayoutReaperService);
  });

  // ── eligibility sweep (booking กลายเป็น "ไม่ควรจ่าย" หลัง payout ถูกสร้าง) ──

  describe('eligibility sweep', () => {
    const scheduledRow = { id: 'p-sched', bookingId: 'booking-9' };

    it('payout ที่ยังไม่โอน + booking โดน deny → cancel ผ่าน state machine', async () => {
      prisma.payout.findMany
        .mockResolvedValueOnce([]) // stale-processing pass
        .mockResolvedValueOnce([scheduledRow]); // eligibility pass
      eligibility.check.mockResolvedValue({
        kind: 'deny',
        reason: 'payment_refunded',
        evidence: { verdict: 'valid', refundedAmount: 1000 },
      });

      await reaper.run();

      expect(stateMachine.claim).toHaveBeenCalledWith(
        'p-sched',
        PayoutStatus.scheduled,
        PayoutStatus.cancelled,
        expect.objectContaining({
          reason: 'payout_gate_denied:payment_refunded',
        }),
      );
    });

    it('dispute ยังเปิดอยู่ (hold) → ห้าม cancel (กู้คืนไม่ได้ถ้ายกเลิกผิด)', async () => {
      prisma.payout.findMany
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([scheduledRow]);
      eligibility.check.mockResolvedValue({
        kind: 'hold',
        reason: 'proof_needs_review',
        evidence: {},
      });

      await reaper.run();

      expect(stateMachine.claim).not.toHaveBeenCalled();
    });

    it('eligible → ไม่แตะ', async () => {
      prisma.payout.findMany
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([scheduledRow]);

      await reaper.run();

      expect(stateMachine.claim).not.toHaveBeenCalled();
    });

    it('sweep ดูเฉพาะ scheduled (processing = worker ถือ lock อยู่)', async () => {
      prisma.payout.findMany.mockResolvedValue([]);

      await reaper.run();

      expect(prisma.payout.findMany).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({
          where: { status: PayoutStatus.scheduled },
        }),
      );
    });

    it('kill-switch on → sweep ไม่ทำงาน', async () => {
      killswitch.gate.mockReturnValue(true);

      await reaper.run();

      expect(eligibility.check).not.toHaveBeenCalled();
      expect(stateMachine.claim).not.toHaveBeenCalled();
    });

    it('1 ใบพัง → ใบอื่นยังถูกกวาดต่อ', async () => {
      prisma.payout.findMany.mockResolvedValueOnce([]).mockResolvedValueOnce([
        { id: 'p-a', bookingId: 'b-a' },
        { id: 'p-b', bookingId: 'b-b' },
      ]);
      eligibility.check
        .mockRejectedValueOnce(new Error('db down'))
        .mockResolvedValueOnce({
          kind: 'deny',
          reason: 'payment_refunded',
          evidence: {},
        });

      await expect(reaper.run()).resolves.toBeUndefined();
      expect(stateMachine.claim).toHaveBeenCalledTimes(1);
      expect(stateMachine.claim).toHaveBeenCalledWith(
        'p-b',
        PayoutStatus.scheduled,
        PayoutStatus.cancelled,
        expect.anything(),
      );
    });
  });

  // ── kill-switch ──────────────────────────────────────────────────────────

  it('kill-switch on → skip whole tick', async () => {
    killswitch.gate.mockReturnValue(true);
    await reaper.run();
    expect(prisma.payout.findMany).not.toHaveBeenCalled();
    expect(stateMachine.transition).not.toHaveBeenCalled();
  });

  // ── query filter ─────────────────────────────────────────────────────────

  it('run() query filter: status=processing AND updatedAt < now - STALE_MINUTES', async () => {
    prisma.payout.findMany.mockResolvedValue([]);
    await reaper.run();

    expect(prisma.payout.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          status: PayoutStatus.processing,
          updatedAt: { lt: expect.any(Date) },
        }),
      }),
    );
  });

  it('run() — no stale rows → nothing to do', async () => {
    prisma.payout.findMany.mockResolvedValue([]);
    await reaper.run();
    expect(stateMachine.transition).not.toHaveBeenCalled();
  });

  // ── reap retry ───────────────────────────────────────────────────────────

  it('stale row + policy=retry → transition scheduled + retry_count++ + next_retry_at', async () => {
    prisma.payout.findMany.mockResolvedValue([makePayout({ retryCount: 1 })]);
    const nextRetryAt = new Date('2026-08-01T10:30:00Z');
    retryPolicy.decide.mockReturnValue({
      kind: 'retry',
      nextRetryAt,
      newRetryCount: 2,
      backoffMinutes: 30,
    });

    await reaper.run();

    expect(retryPolicy.decide).toHaveBeenCalledWith(1);
    expect(stateMachine.transition).toHaveBeenCalledWith(
      PAYOUT_ID,
      PayoutStatus.scheduled,
      expect.objectContaining({
        reason: 'stale_processing_reaped',
        nextRetryAt,
        extraPayoutFields: { retryCount: { increment: 1 } },
      }),
    );
    // Only 1 transition (no failed)
    expect(stateMachine.transition).toHaveBeenCalledTimes(1);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  // ── reap terminate ───────────────────────────────────────────────────────

  it('stale row + policy=terminate → tx: scheduled then failed', async () => {
    prisma.payout.findMany.mockResolvedValue([makePayout({ retryCount: 4 })]);
    retryPolicy.decide.mockReturnValue({ kind: 'terminate', newRetryCount: 5 });

    await reaper.run();

    expect(prisma.$transaction).toHaveBeenCalled();
    const targets = stateMachine.transition.mock.calls.map((c) => c[1]);
    expect(targets).toContain(PayoutStatus.scheduled);
    expect(targets).toContain(PayoutStatus.failed);

    const failedCall = stateMachine.transition.mock.calls.find(
      (c) => c[1] === PayoutStatus.failed,
    );
    expect(failedCall).toBeDefined();
    expect(failedCall![2]).toMatchObject({
      reason: 'max_retries_exceeded_from_reaper',
    });
  });

  // ── race safety ──────────────────────────────────────────────────────────

  it('transition throws InvalidPayoutTransitionError mid-flight (race) → log + continue', async () => {
    prisma.payout.findMany.mockResolvedValue([
      makePayout({ id: 'p-a', retryCount: 0 }),
      makePayout({ id: 'p-b', retryCount: 0 }),
    ]);
    retryPolicy.decide.mockReturnValue({
      kind: 'retry',
      nextRetryAt: new Date(),
      newRetryCount: 1,
      backoffMinutes: 10,
    });
    // first transition throws (race), second succeeds
    stateMachine.transition
      .mockRejectedValueOnce(
        new InvalidPayoutTransitionError(
          PayoutStatus.paid, // status ตอนนี้เปลี่ยนไปแล้ว
          PayoutStatus.scheduled,
        ),
      )
      .mockResolvedValueOnce({});

    await expect(reaper.run()).resolves.toBeUndefined();
    // Both attempted (1st failed silently, 2nd succeeded)
    expect(stateMachine.transition).toHaveBeenCalledTimes(2);
  });

  // ── multiple rows ────────────────────────────────────────────────────────

  it('processes multiple stale rows in one tick', async () => {
    prisma.payout.findMany.mockResolvedValue([
      makePayout({ id: 'p-a', retryCount: 0 }),
      makePayout({ id: 'p-b', retryCount: 1 }),
    ]);
    retryPolicy.decide.mockImplementation((n: number) => ({
      kind: 'retry',
      nextRetryAt: new Date(),
      newRetryCount: n + 1,
      backoffMinutes: 10 * (n + 1),
    }));

    await reaper.run();
    expect(stateMachine.transition).toHaveBeenCalledTimes(2);
  });

  // ── env validation ───────────────────────────────────────────────────────

  it('malformed STALE_MINUTES → throws', async () => {
    config.getOrThrow.mockReturnValueOnce('abc');
    prisma.payout.findMany.mockResolvedValue([]);
    await expect(reaper.run()).rejects.toThrow(
      /PAYOUT_STALE_PROCESSING_MINUTES/,
    );
  });
});
