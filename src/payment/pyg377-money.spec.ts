/**
 * PYG-377 [QA] — refund routing, over-refund, double-loss, capture idempotency.
 *
 * Uses a counting Omise mock (per the card's precondition) to assert the exact number of
 * money calls. Refund uses a STATEFUL payment mock so sequential refunds accumulate
 * refunded_amount like the real DB row. Reconciliation / PYG-309 / payout are mapped to
 * their existing green specs in the QA report; this file covers the count-critical paths.
 */
import { BadRequestException, ConflictException } from '@nestjs/common';
import { RefundService, type RefundSource } from './refund.service';
import { IdempotencyService } from './idempotency.service';
import { PaymentStatus } from './entities/payment-status.enum';

/** counting Omise mock. */
function countingOmise() {
  return {
    createRefund: jest.fn().mockResolvedValue({ id: 'rfnd' }),
    captureCharge: jest.fn().mockResolvedValue({ id: 'chrg', paid: true, amount: 100000 }),
    createTransfer: jest.fn().mockResolvedValue({ id: 'trsf', status: 'paid' }),
  };
}

/** RefundService over a STATEFUL payment row (refunded_amount accumulates across calls). */
function statefulRefund(opts: { payoutStatus?: string | null } = {}) {
  const payment = {
    id: 'pay-1', bookingId: 'bk-1', patientId: 'pt', caregiverId: 'cg',
    amount: 1000, capturedAmount: 1000, refundedAmount: 0,
    paymentStatus: PaymentStatus.captured, omiseChargeId: 'chrg_1', metadata: {},
  };
  const tx = {
    $queryRaw: jest.fn().mockResolvedValue([]),
    payment: {
      findUnique: jest.fn().mockImplementation(async () => ({ ...payment })),
      update: jest.fn().mockImplementation(async ({ data }: { data: Record<string, number> }) => {
        if (data.refundedAmount !== undefined) payment.refundedAmount = data.refundedAmount;
        if (data.capturedAmount !== undefined) payment.capturedAmount = data.capturedAmount;
        return { ...payment };
      }),
    },
    payout: { findUnique: jest.fn().mockResolvedValue(opts.payoutStatus ? { status: opts.payoutStatus } : null) },
  };
  const prisma = { $transaction: jest.fn((cb: (t: typeof tx) => unknown) => cb(tx)) };
  const fsm = {
    transition: jest.fn().mockImplementation(async (_id, target) => {
      payment.paymentStatus = target; // reflect status so the next call sees it
      return { ...payment };
    }),
  };
  const omise = countingOmise();
  const idem = {
    runOnce: jest.fn((p: { key: string; fn: (k: string) => unknown }) => p.fn(p.key)),
  };
  const svc = new RefundService(prisma as never, fsm as never, omise as never, { emit: jest.fn() } as never, idem as never);
  return { svc, omise, payment };
}

const REASON = 'valid refund reason enough';

describe('PYG-377 refund routing — every source runs through RefundService, createRefund once', () => {
  const sources: RefundSource[] = ['dispute', 'payout_exception', 'admin_manual', 'admin_override'];
  it.each(sources)('TC_01/02/03/04 source=%s → createRefund exactly 1 + refunded_amount updated', async (source) => {
    const { svc, omise, payment } = statefulRefund();
    await svc.refund({ paymentId: 'pay-1', amount: 400, reason: REASON, source });
    expect(omise.createRefund).toHaveBeenCalledTimes(1);
    expect(payment.refundedAmount).toBe(400);
  });
});

describe('PYG-377 over-refund guards', () => {
  it('TC_06 full refund twice → 2nd rejected, createRefund exactly 1 total', async () => {
    const { svc, omise } = statefulRefund();
    await svc.refund({ paymentId: 'pay-1', reason: REASON, source: 'admin_manual' }); // full 1000
    await expect(
      svc.refund({ paymentId: 'pay-1', reason: REASON, source: 'admin_manual' }),
    ).rejects.toBeInstanceOf(BadRequestException); // nothing left / status refunded
    expect(omise.createRefund).toHaveBeenCalledTimes(1);
  });

  it("TC_07 40% x3 → 3rd rejected 'เกินยอดที่เก็บได้', createRefund exactly 2", async () => {
    const { svc, omise } = statefulRefund();
    await svc.refund({ paymentId: 'pay-1', amount: 400, reason: REASON, source: 'admin_manual' });
    await svc.refund({ paymentId: 'pay-1', amount: 400, reason: REASON, source: 'admin_manual' });
    await expect(
      svc.refund({ paymentId: 'pay-1', amount: 400, reason: REASON, source: 'admin_manual' }),
    ).rejects.toThrow('เกินยอดที่เก็บได้');
    expect(omise.createRefund).toHaveBeenCalledTimes(2);
  });

  it('TC_08 payout already paid → rejected with admin remedy, createRefund NOT called', async () => {
    const { svc, omise } = statefulRefund({ payoutStatus: 'paid' });
    const p = svc.refund({ paymentId: 'pay-1', amount: 400, reason: REASON, source: 'dispute' });
    await expect(p).rejects.toBeInstanceOf(ConflictException);
    await expect(
      svc.refund({ paymentId: 'pay-1', amount: 400, reason: REASON, source: 'dispute' }),
    ).rejects.toThrow(/admin/);
    expect(omise.createRefund).not.toHaveBeenCalled();
  });
});

describe('PYG-377 idempotency — Omise called once per key', () => {
  /** idempotency store simulating the PK: 2nd insert throws P2002 → cached result returned. */
  function idemService() {
    const store = new Map<string, { result: unknown }>();
    const { Prisma } = require('@prisma/client');
    const prisma = {
      idempotencyKey: {
        create: jest.fn(async ({ data }: { data: { key: string } }) => {
          if (store.has(data.key)) {
            throw new Prisma.PrismaClientKnownRequestError('dup', { code: 'P2002', clientVersion: 't' });
          }
          store.set(data.key, { result: null });
          return {};
        }),
        findUnique: jest.fn(async ({ where }: { where: { key: string } }) =>
          store.has(where.key) ? { key: where.key, result: store.get(where.key)!.result } : null,
        ),
        update: jest.fn(async ({ where, data }: { where: { key: string }; data: { result: unknown } }) => {
          store.get(where.key)!.result = data.result;
          return {};
        }),
      },
    };
    return new IdempotencyService(prisma as never);
  }

  it('TC_09 capture twice, same key → captureCharge called once', async () => {
    const idem = idemService();
    const omise = countingOmise();
    const key = 'capture:bk-1';
    await idem.runOnce({ key, action: 'capture', fn: (k) => omise.captureCharge('chrg_1', k) });
    await expect(
      idem.runOnce({ key, action: 'capture', fn: (k) => omise.captureCharge('chrg_1', k) }),
    ).resolves.toBeDefined(); // 2nd → cached result, no throw
    expect(omise.captureCharge).toHaveBeenCalledTimes(1);
  });

  it('TC_10 refund twice, same key → createRefund called once', async () => {
    const idem = idemService();
    const omise = countingOmise();
    const key = 'refund:pay-1:0';
    await idem.runOnce({ key, action: 'refund', fn: (k) => omise.createRefund('chrg_1', 40000, k) });
    await idem.runOnce({ key, action: 'refund', fn: (k) => omise.createRefund('chrg_1', 40000, k) }).catch(() => {});
    expect(omise.createRefund).toHaveBeenCalledTimes(1);
  });
});
