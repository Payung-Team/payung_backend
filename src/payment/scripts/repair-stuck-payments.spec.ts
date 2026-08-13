/**
 * PYG-375 STEP 2 — repair-stuck-payments tests
 *
 * Covers: the 5 decision buckets, the webhook-lost → captured (never expired) case, the
 * unreachable → skip (no mutation) case, CSV BOM, and the --apply path (FOR UPDATE recheck →
 * transition, + skip:already_moved idempotency, + captured_amount set).
 */
import { Prisma } from '@prisma/client';
import {
  planRow,
  toCsv,
  summarize,
  RepairBucket,
  UTF8_BOM,
  type StuckPayment,
  type ChargeOutcome,
} from './repair-stuck-payments.core';
import { PaymentStatus } from '../entities/payment-status.enum';
import { applyOne } from './repair-stuck-payments';

function stuck(over: Partial<StuckPayment> = {}): StuckPayment {
  return {
    id: 'pay-1',
    bookingId: 'bk-1',
    paymentMethod: 'promptpay',
    amount: new Prisma.Decimal(1000),
    omiseChargeId: 'chrg_1',
    paymentStatus: 'pending',
    ...over,
  };
}

describe('repair core — decision table (§4)', () => {
  it('paid=true → captured (webhook-lost), sets captured_amount, NEVER expired', () => {
    const r = planRow(stuck(), { kind: 'ok', paid: true, authorized: true, amountSatang: 100000 });
    expect(r.proposedStatus).toBe(PaymentStatus.captured);
    expect(r.bucket).toBe(RepairBucket.CAPTURED);
    expect(r.capturedAmountBaht).toBe(1000);
    expect(r.proposedStatus).not.toBe(PaymentStatus.expired);
  });

  it('paid=false & authorized=true → held', () => {
    const r = planRow(stuck(), { kind: 'ok', paid: false, authorized: true, amountSatang: 100000 });
    expect(r.proposedStatus).toBe(PaymentStatus.held);
    expect(r.bucket).toBe(RepairBucket.HELD);
    expect(r.capturedAmountBaht).toBeNull();
  });

  it('paid=false & authorized=false → expired (only because we asked Omise)', () => {
    const r = planRow(stuck(), { kind: 'ok', paid: false, authorized: false, amountSatang: 100000 });
    expect(r.proposedStatus).toBe(PaymentStatus.expired);
    expect(r.bucket).toBe(RepairBucket.EXPIRED);
  });

  it('404 not_found → failed', () => {
    const r = planRow(stuck(), { kind: 'not_found' });
    expect(r.proposedStatus).toBe(PaymentStatus.failed);
    expect(r.bucket).toBe(RepairBucket.FAILED);
  });

  it('NULL omise_charge_id → failed', () => {
    const r = planRow(stuck({ omiseChargeId: null }), { kind: 'no_charge_id' });
    expect(r.proposedStatus).toBe(PaymentStatus.failed);
    expect(r.bucket).toBe(RepairBucket.FAILED);
  });

  it('unreachable → SKIP, no proposed write (row left pending)', () => {
    const r = planRow(stuck(), { kind: 'unreachable' });
    expect(r.proposedStatus).toBeNull();
    expect(r.bucket).toBe(RepairBucket.SKIP_UNREACHABLE);
  });

  it('summarize counts every bucket', () => {
    const rows = [
      planRow(stuck({ id: 'a' }), { kind: 'ok', paid: true, authorized: true, amountSatang: 1 }),
      planRow(stuck({ id: 'b' }), { kind: 'ok', paid: false, authorized: true, amountSatang: 1 }),
      planRow(stuck({ id: 'c' }), { kind: 'ok', paid: false, authorized: false, amountSatang: 1 }),
      planRow(stuck({ id: 'd' }), { kind: 'not_found' }),
      planRow(stuck({ id: 'e' }), { kind: 'unreachable' }),
    ];
    const c = summarize(rows);
    expect(c[RepairBucket.CAPTURED]).toBe(1);
    expect(c[RepairBucket.HELD]).toBe(1);
    expect(c[RepairBucket.EXPIRED]).toBe(1);
    expect(c[RepairBucket.FAILED]).toBe(1);
    expect(c[RepairBucket.SKIP_UNREACHABLE]).toBe(1);
  });
});

describe('repair core — CSV', () => {
  it('starts with UTF-8 BOM, has the §7 columns, preserves Thai', () => {
    const r = planRow(
      { ...stuck(), paymentMethod: 'พร้อมเพย์' },
      { kind: 'ok', paid: true, authorized: true, amountSatang: 100000 },
    );
    const csv = toCsv([r]);
    expect(csv.startsWith(UTF8_BOM)).toBe(true);
    const header = csv.slice(UTF8_BOM.length).split('\r\n')[0];
    for (const col of ['paymentId', 'omisePaid', 'omiseAmountSatang', 'proposedStatus', 'bucket', 'reason']) {
      expect(header).toContain(col);
    }
    expect(csv).toContain('พร้อมเพย์');
  });
});

describe('repair apply — FOR UPDATE recheck + idempotency (§6)', () => {
  function mockTx(freshStatus: string | null) {
    return {
      $queryRaw: jest.fn().mockResolvedValue([]),
      payment: {
        findUnique: jest.fn().mockResolvedValue(freshStatus ? { paymentStatus: freshStatus } : null),
        update: jest.fn().mockResolvedValue({}),
      },
    };
  }
  const capturedRow = planRow(stuck(), {
    kind: 'ok',
    paid: true,
    authorized: true,
    amountSatang: 100000,
  });

  it('row still pending → FSM transition (in tx) + captured_amount set', async () => {
    const tx = mockTx('pending');
    const prisma = { $transaction: jest.fn((cb: (t: typeof tx) => unknown) => cb(tx)) };
    const fsm = { transition: jest.fn().mockResolvedValue({}) };

    const moved = await applyOne(prisma as never, fsm as never, capturedRow);

    expect(moved).toBe(true);
    expect(tx.$queryRaw).toHaveBeenCalled(); // SELECT … FOR UPDATE
    expect(fsm.transition).toHaveBeenCalledWith(
      'pay-1',
      PaymentStatus.captured,
      expect.objectContaining({
        changedBy: 'system:pyg-375-repair',
        reason: expect.stringContaining('captured'),
        metadata: expect.objectContaining({ omisePaid: true }),
      }),
      tx,
    );
    expect(tx.payment.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ capturedAmount: expect.anything() }) }),
    );
  });

  it('row already moved (not pending) → skip:already_moved, NO transition (idempotent re-run)', async () => {
    const tx = mockTx('captured'); // live cron already moved it
    const prisma = { $transaction: jest.fn((cb: (t: typeof tx) => unknown) => cb(tx)) };
    const fsm = { transition: jest.fn() };

    const moved = await applyOne(prisma as never, fsm as never, capturedRow);

    expect(moved).toBe(false);
    expect(fsm.transition).not.toHaveBeenCalled();
    expect(tx.payment.update).not.toHaveBeenCalled();
  });

  it('non-captured proposal does not set captured_amount', async () => {
    const tx = mockTx('pending');
    const prisma = { $transaction: jest.fn((cb: (t: typeof tx) => unknown) => cb(tx)) };
    const fsm = { transition: jest.fn().mockResolvedValue({}) };
    const expiredRow = planRow(stuck(), { kind: 'ok', paid: false, authorized: false, amountSatang: 1 });

    await applyOne(prisma as never, fsm as never, expiredRow);

    expect(fsm.transition).toHaveBeenCalledWith('pay-1', PaymentStatus.expired, expect.anything(), tx);
    expect(tx.payment.update).not.toHaveBeenCalled();
  });
});
