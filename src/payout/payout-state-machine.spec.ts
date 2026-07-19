/**
 * PayoutStateMachine tests (PYG-331 ก้อน B)
 *
 * ครอบคลุม:
 *  - canTransition matrix ครบทุก case
 *  - transition happy path + throw on invalid
 *  - claim race-safe (won / lost)
 *  - recordInitialStatus (from=null)
 *  - atomicity: history + status ในก้อน tx เดียวกัน
 */
import { Test, TestingModule } from '@nestjs/testing';
import { NotFoundException } from '@nestjs/common';
import { PayoutStateMachine } from './payout-state-machine';
import { PrismaService } from '../common/prisma.service';
import { PayoutStatus } from './entities/payout-status.enum';
import { InvalidPayoutTransitionError } from './errors/invalid-payout-transition.error';

const PAYOUT_ID = 'p-1';

function fakePayout(status: PayoutStatus, overrides: Record<string, unknown> = {}) {
  return {
    id: PAYOUT_ID,
    status,
    retryCount: 0,
    ...overrides,
  };
}

describe('PayoutStateMachine', () => {
  let sm: PayoutStateMachine;
  let tx: {
    payout: { findUnique: jest.Mock; update: jest.Mock; updateMany: jest.Mock };
    payoutStatusHistory: { create: jest.Mock };
  };
  let prisma: {
    payout: typeof tx.payout;
    payoutStatusHistory: typeof tx.payoutStatusHistory;
    $transaction: jest.Mock;
  };

  beforeEach(async () => {
    tx = {
      payout: {
        findUnique: jest.fn(),
        update: jest.fn(),
        updateMany: jest.fn(),
      },
      payoutStatusHistory: { create: jest.fn() },
    };
    prisma = {
      payout: tx.payout,
      payoutStatusHistory: tx.payoutStatusHistory,
      // จำลอง $transaction: เรียก callback ด้วย tx mock
      $transaction: jest.fn((cb: (t: typeof tx) => unknown) => cb(tx)),
    };

    const moduleRef: TestingModule = await Test.createTestingModule({
      providers: [
        PayoutStateMachine,
        { provide: PrismaService, useValue: prisma },
      ],
    }).compile();

    sm = moduleRef.get(PayoutStateMachine);
  });

  // ─── canTransition ────────────────────────────────────────────────────────

  describe('canTransition', () => {
    it.each([
      [PayoutStatus.scheduled, PayoutStatus.processing],
      [PayoutStatus.scheduled, PayoutStatus.failed],
      [PayoutStatus.scheduled, PayoutStatus.cancelled],
      [PayoutStatus.processing, PayoutStatus.paid],
      [PayoutStatus.processing, PayoutStatus.scheduled],
    ])('allow %s → %s', (from, to) => {
      expect(sm.canTransition(from, to)).toBe(true);
    });

    it.each([
      // processing → failed ต้องผ่าน scheduled ก่อน (retry เป็นเจ้าของ)
      [PayoutStatus.processing, PayoutStatus.failed],
      // processing → cancelled ห้าม (worker ถือ lock อยู่)
      [PayoutStatus.processing, PayoutStatus.cancelled],
      // reverse ห้าม
      [PayoutStatus.paid, PayoutStatus.scheduled],
      [PayoutStatus.paid, PayoutStatus.processing],
      [PayoutStatus.failed, PayoutStatus.scheduled],
      [PayoutStatus.cancelled, PayoutStatus.scheduled],
      // same → same ห้าม
      [PayoutStatus.scheduled, PayoutStatus.scheduled],
    ])('reject %s → %s', (from, to) => {
      expect(sm.canTransition(from, to)).toBe(false);
    });
  });

  // ─── transition (happy path) ──────────────────────────────────────────────

  describe('transition', () => {
    it('scheduled → processing: update status + insert history atomically', async () => {
      tx.payout.findUnique.mockResolvedValue(fakePayout(PayoutStatus.scheduled));
      tx.payout.update.mockResolvedValue(fakePayout(PayoutStatus.processing));

      await sm.transition(PAYOUT_ID, PayoutStatus.processing, {
        changedBy: 'admin-1',
        reason: 'test',
        metadata: { note: 'x' },
      });

      // update called with new status
      expect(tx.payout.update).toHaveBeenCalledWith({
        where: { id: PAYOUT_ID },
        data: expect.objectContaining({ status: PayoutStatus.processing }),
      });
      // history has from + to + audit fields
      expect(tx.payoutStatusHistory.create).toHaveBeenCalledWith({
        data: {
          payoutId: PAYOUT_ID,
          fromStatus: PayoutStatus.scheduled,
          toStatus: PayoutStatus.processing,
          changedBy: 'admin-1',
          reason: 'test',
          metadata: { note: 'x' },
        },
      });
    });

    it('passes extraPayoutFields into the update', async () => {
      tx.payout.findUnique.mockResolvedValue(fakePayout(PayoutStatus.processing));
      tx.payout.update.mockResolvedValue({});

      await sm.transition(PAYOUT_ID, PayoutStatus.paid, {
        extraPayoutFields: { omiseTransferId: 'trsf_1', processedAt: new Date('2026-08-01T00:00:00Z') },
        nextRetryAt: null,
      });

      const args = tx.payout.update.mock.calls[0][0];
      expect(args.data).toMatchObject({
        status: PayoutStatus.paid,
        omiseTransferId: 'trsf_1',
        nextRetryAt: null,
      });
    });

    it('nextRetryAt undefined → do NOT touch the column', async () => {
      tx.payout.findUnique.mockResolvedValue(fakePayout(PayoutStatus.processing));
      tx.payout.update.mockResolvedValue({});

      await sm.transition(PAYOUT_ID, PayoutStatus.paid);

      const args = tx.payout.update.mock.calls[0][0];
      expect(args.data).not.toHaveProperty('nextRetryAt');
    });

    it('throws NotFoundException when payout is missing', async () => {
      tx.payout.findUnique.mockResolvedValue(null);
      await expect(
        sm.transition(PAYOUT_ID, PayoutStatus.processing),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(tx.payout.update).not.toHaveBeenCalled();
    });

    it('throws InvalidPayoutTransitionError on invalid transition — no writes', async () => {
      // paid → scheduled ห้าม
      tx.payout.findUnique.mockResolvedValue(fakePayout(PayoutStatus.paid));
      await expect(
        sm.transition(PAYOUT_ID, PayoutStatus.scheduled),
      ).rejects.toBeInstanceOf(InvalidPayoutTransitionError);
      expect(tx.payout.update).not.toHaveBeenCalled();
      expect(tx.payoutStatusHistory.create).not.toHaveBeenCalled();
    });

    it('rejects processing → failed (must go via scheduled first)', async () => {
      tx.payout.findUnique.mockResolvedValue(fakePayout(PayoutStatus.processing));
      await expect(
        sm.transition(PAYOUT_ID, PayoutStatus.failed),
      ).rejects.toBeInstanceOf(InvalidPayoutTransitionError);
    });

    it('accepts external tx (does not open its own)', async () => {
      tx.payout.findUnique.mockResolvedValue(fakePayout(PayoutStatus.scheduled));
      tx.payout.update.mockResolvedValue({});

      await sm.transition(
        PAYOUT_ID,
        PayoutStatus.processing,
        {},
        tx as never,
      );
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });
  });

  // ─── claim (race-safe) ────────────────────────────────────────────────────

  describe('claim', () => {
    it('won race: conditional updateMany count=1 → claimed=true + history + fresh row', async () => {
      tx.payout.updateMany.mockResolvedValue({ count: 1 });
      tx.payout.findUnique.mockResolvedValue(fakePayout(PayoutStatus.processing));

      const result = await sm.claim(
        PAYOUT_ID,
        PayoutStatus.scheduled,
        PayoutStatus.processing,
        { reason: 'worker_claim', extraPayoutFields: { recipientId: 'recp_1' } },
      );

      expect(result.claimed).toBe(true);
      expect(result.payout).not.toBeNull();

      // conditional UPDATE: WHERE status=from (race guard)
      expect(tx.payout.updateMany).toHaveBeenCalledWith({
        where: { id: PAYOUT_ID, status: PayoutStatus.scheduled },
        data: expect.objectContaining({
          status: PayoutStatus.processing,
          recipientId: 'recp_1',
        }),
      });
      // history inserted with correct from/to
      expect(tx.payoutStatusHistory.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          payoutId: PAYOUT_ID,
          fromStatus: PayoutStatus.scheduled,
          toStatus: PayoutStatus.processing,
          reason: 'worker_claim',
        }),
      });
    });

    it('lost race: updateMany count=0 → claimed=false + NO history + NO extra read', async () => {
      tx.payout.updateMany.mockResolvedValue({ count: 0 });

      const result = await sm.claim(
        PAYOUT_ID,
        PayoutStatus.scheduled,
        PayoutStatus.processing,
      );

      expect(result.claimed).toBe(false);
      expect(result.payout).toBeNull();
      expect(tx.payoutStatusHistory.create).not.toHaveBeenCalled();
      expect(tx.payout.findUnique).not.toHaveBeenCalled();
    });

    it('throws InvalidPayoutTransitionError if from→target is not a legal transition', async () => {
      // paid → scheduled ห้าม → ต้อง throw ทันที ไม่ยิง update
      await expect(
        sm.claim(PAYOUT_ID, PayoutStatus.paid, PayoutStatus.scheduled),
      ).rejects.toBeInstanceOf(InvalidPayoutTransitionError);
      expect(tx.payout.updateMany).not.toHaveBeenCalled();
    });
  });

  // ─── recordInitialStatus ──────────────────────────────────────────────────

  describe('recordInitialStatus', () => {
    it('writes from=null → to=scheduled', async () => {
      await sm.recordInitialStatus(PAYOUT_ID, PayoutStatus.scheduled, {
        reason: 'created',
        metadata: { bookingId: 'b1' },
      });

      expect(prisma.payoutStatusHistory.create).toHaveBeenCalledWith({
        data: {
          payoutId: PAYOUT_ID,
          fromStatus: null,
          toStatus: PayoutStatus.scheduled,
          changedBy: undefined,
          reason: 'created',
          metadata: { bookingId: 'b1' },
        },
      });
    });

    it('respects external tx', async () => {
      await sm.recordInitialStatus(
        PAYOUT_ID,
        PayoutStatus.scheduled,
        {},
        tx as never,
      );
      // ควรใช้ tx client (ที่ mock), ไม่ใช่ prisma root
      expect(tx.payoutStatusHistory.create).toHaveBeenCalled();
    });
  });

  // ─── atomicity ────────────────────────────────────────────────────────────

  describe('atomicity', () => {
    it('history insert failure rolls back the status update ($transaction throws)', async () => {
      // จำลอง $transaction ที่ throw error กลาง ๆ
      prisma.$transaction.mockImplementationOnce(
        async (cb: (t: typeof tx) => Promise<unknown>) => {
          tx.payout.findUnique.mockResolvedValue(fakePayout(PayoutStatus.scheduled));
          tx.payout.update.mockResolvedValue({});
          tx.payoutStatusHistory.create.mockRejectedValue(
            new Error('history write failed'),
          );
          // เรียก callback → callback จะ throw
          return cb(tx);
        },
      );

      await expect(
        sm.transition(PAYOUT_ID, PayoutStatus.processing),
      ).rejects.toThrow('history write failed');

      // update ถูก call แต่ tx จะ rollback (จำลองด้วย throw ที่ callback level)
      // สิ่งที่ทดสอบได้จริงคือ throw ถูก propagate → caller รู้ว่าล้ม
    });
  });
});
