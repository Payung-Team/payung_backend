/**
 * RefundService unit tests (PYG-374)
 *
 * ครอบ DoD:
 * - dispute / payout_exception / admin_manual เข้า RefundService และเรียก Omise "ครั้งเดียว"
 * - three 40% partial refunds → ครั้งที่ 3 ถูก reject (เกินยอดที่เก็บได้)
 * - payout จ่ายแล้ว → refund ถูก reject พร้อมข้อความให้ใช้ช่องทาง admin
 * - full → refunded, partial → partially_refunded
 * - payment_status_history ทุกแถวมี source + reason (ผ่าน fsm.transition metadata/reason)
 * - reason < 10 → reject; legacy partially_refunded (captured_amount null) → reject
 */
import {
  BadRequestException,
  ConflictException,
} from '@nestjs/common';
import { RefundService, type RefundSource } from './refund.service';
import { PaymentStatus } from './entities/payment-status.enum';
import { BOOKING_EVENTS } from '../notification/events/booking-event';

type AnyMock = jest.Mock;

describe('RefundService', () => {
  let service: RefundService;
  let tx: {
    $queryRaw: AnyMock;
    payment: { findUnique: AnyMock; update: AnyMock };
    payout: { findUnique: AnyMock };
  };
  let prisma: { $transaction: AnyMock };
  let fsm: { transition: AnyMock };
  let omise: { createRefund: AnyMock };
  let events: { emit: AnyMock };
  let idempotency: { runOnce: AnyMock };

  const REASON = 'dispute resolved: caregiver no-show'; // >= 10 chars

  const makePayment = (o: Partial<Record<string, unknown>> = {}) => ({
    id: 'pay-1',
    bookingId: 'bk-1',
    patientId: 'pt-1',
    caregiverId: 'cg-1',
    amount: 1000,
    capturedAmount: 1000,
    refundedAmount: 0,
    paymentStatus: PaymentStatus.captured,
    omiseChargeId: 'chrg_1',
    metadata: {},
    ...o,
  });

  beforeEach(() => {
    tx = {
      $queryRaw: jest.fn().mockResolvedValue([]),
      payment: {
        findUnique: jest.fn(),
        update: jest.fn().mockImplementation(({ data }) => ({
          ...makePayment(),
          ...data,
        })),
      },
      payout: { findUnique: jest.fn().mockResolvedValue(null) },
    };
    prisma = { $transaction: jest.fn((cb: (t: unknown) => unknown) => cb(tx)) };
    fsm = { transition: jest.fn().mockResolvedValue({}) };
    omise = { createRefund: jest.fn().mockResolvedValue({ id: 'rfnd_1' }) };
    events = { emit: jest.fn() };
    // PYG-375: default runOnce calls fn(key) directly (idempotency table tested separately)
    idempotency = {
      runOnce: jest.fn((params: { key: string; fn: (k: string) => unknown }) =>
        params.fn(params.key),
      ),
    };

    service = new RefundService(
      prisma as never,
      fsm as never,
      omise as never,
      events as never,
      idempotency as never,
    );
  });

  it('PYG-375: replay same key → stored Omise result, createRefund NOT called again', async () => {
    tx.payment.findUnique.mockResolvedValue(makePayment());
    // idempotency returns the stored result instead of running fn (simulates PK replay)
    idempotency.runOnce.mockResolvedValueOnce({ id: 'rfnd_stored' });

    await service.refund({ paymentId: 'pay-1', reason: REASON, source: 'admin_manual' });

    expect(omise.createRefund).not.toHaveBeenCalled();
    // key reused, not redefined
    expect(idempotency.runOnce).toHaveBeenCalledWith(
      expect.objectContaining({ key: 'refund:pay-1:0', action: 'refund' }),
      expect.anything(),
    );
  });

  describe('every route enters RefundService and calls Omise exactly once', () => {
    const sources: RefundSource[] = ['dispute', 'payout_exception', 'admin_manual'];
    it.each(sources)('source=%s → 1 Omise call + REFUND_ISSUED emitted', async (source) => {
      tx.payment.findUnique.mockResolvedValue(makePayment());

      await service.refund({ paymentId: 'pay-1', reason: REASON, source });

      expect(omise.createRefund).toHaveBeenCalledTimes(1);
      expect(fsm.transition).toHaveBeenCalledTimes(1);
      expect(events.emit).toHaveBeenCalledWith(
        BOOKING_EVENTS.REFUND_ISSUED,
        expect.objectContaining({ bookingId: 'bk-1', metadata: expect.objectContaining({ source }) }),
      );
    });
  });

  it('locks the row with SELECT … FOR UPDATE before reading', async () => {
    tx.payment.findUnique.mockResolvedValue(makePayment());
    await service.refund({ paymentId: 'pay-1', reason: REASON, source: 'admin_manual' });
    expect(tx.$queryRaw).toHaveBeenCalledTimes(1);
    // lock must precede the typed read
    expect(tx.$queryRaw.mock.invocationCallOrder[0]).toBeLessThan(
      tx.payment.findUnique.mock.invocationCallOrder[0],
    );
  });

  it('full refund → refunded; idempotency key uses refunded_amount_before', async () => {
    tx.payment.findUnique.mockResolvedValue(
      makePayment({ capturedAmount: 1000, refundedAmount: 0 }),
    );

    await service.refund({ paymentId: 'pay-1', reason: REASON, source: 'admin_manual' });

    // full → undefined amount to Omise, key suffix = 0 (refunded before)
    expect(omise.createRefund).toHaveBeenCalledWith('chrg_1', undefined, 'refund:pay-1:0');
    expect(fsm.transition).toHaveBeenCalledWith(
      'pay-1',
      PaymentStatus.refunded,
      expect.objectContaining({ reason: REASON, metadata: expect.objectContaining({ source: 'admin_manual', reason: REASON }) }),
      tx,
    );
  });

  it('partial refund (below total) → partially_refunded, refunded_amount persisted', async () => {
    tx.payment.findUnique.mockResolvedValue(
      makePayment({ capturedAmount: 1000, refundedAmount: 0 }),
    );

    await service.refund({ paymentId: 'pay-1', amount: 400, reason: REASON, source: 'dispute' });

    expect(omise.createRefund).toHaveBeenCalledWith('chrg_1', 40000, 'refund:pay-1:0');
    expect(fsm.transition).toHaveBeenCalledWith(
      'pay-1',
      PaymentStatus.partially_refunded,
      expect.anything(),
      tx,
    );
    expect(tx.payment.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ refundedAmount: 400 }) }),
    );
  });

  it('second partial that reaches 100% → refunded', async () => {
    tx.payment.findUnique.mockResolvedValue(
      makePayment({
        paymentStatus: PaymentStatus.partially_refunded,
        capturedAmount: 1000,
        refundedAmount: 600,
      }),
    );

    await service.refund({ paymentId: 'pay-1', amount: 400, reason: REASON, source: 'dispute' });

    expect(omise.createRefund).toHaveBeenCalledWith('chrg_1', 40000, 'refund:pay-1:60000');
    expect(fsm.transition).toHaveBeenCalledWith('pay-1', PaymentStatus.refunded, expect.anything(), tx);
  });

  it('three 40% partial refunds → the third is rejected (over captured − refunded)', async () => {
    // after two 40% refunds this payment has refunded_amount = 800 of captured 1000
    tx.payment.findUnique.mockResolvedValue(
      makePayment({
        paymentStatus: PaymentStatus.partially_refunded,
        capturedAmount: 1000,
        refundedAmount: 800,
      }),
    );

    await expect(
      service.refund({ paymentId: 'pay-1', amount: 400, reason: REASON, source: 'dispute' }),
    ).rejects.toThrow('จำนวนเงินคืนเกินยอดที่เก็บได้');
    expect(omise.createRefund).not.toHaveBeenCalled();
  });

  it('payout already paid → rejected, tells caller to use admin route, no Omise call', async () => {
    tx.payment.findUnique.mockResolvedValue(makePayment());
    tx.payout.findUnique.mockResolvedValue({ status: 'paid' });

    await expect(
      service.refund({ paymentId: 'pay-1', reason: REASON, source: 'dispute' }),
    ).rejects.toThrow(ConflictException);
    await expect(
      service.refund({ paymentId: 'pay-1', reason: REASON, source: 'dispute' }),
    ).rejects.toThrow(/admin/);
    expect(omise.createRefund).not.toHaveBeenCalled();
  });

  it('payout processing (in-flight transfer) → also rejected', async () => {
    tx.payment.findUnique.mockResolvedValue(makePayment());
    tx.payout.findUnique.mockResolvedValue({ status: 'processing' });

    await expect(
      service.refund({ paymentId: 'pay-1', reason: REASON, source: 'dispute' }),
    ).rejects.toThrow(ConflictException);
    expect(omise.createRefund).not.toHaveBeenCalled();
  });

  it('status not refundable → rejected', async () => {
    tx.payment.findUnique.mockResolvedValue(makePayment({ paymentStatus: PaymentStatus.held }));
    await expect(
      service.refund({ paymentId: 'pay-1', reason: REASON, source: 'admin_manual' }),
    ).rejects.toThrow('ไม่สามารถคืนเงินได้ในสถานะนี้');
    expect(omise.createRefund).not.toHaveBeenCalled();
  });

  it('reason < 10 chars → rejected before any lock/Omise', async () => {
    await expect(
      service.refund({ paymentId: 'pay-1', reason: 'สั้น', source: 'admin_manual' }),
    ).rejects.toThrow(BadRequestException);
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(omise.createRefund).not.toHaveBeenCalled();
  });

  it('legacy partially_refunded with captured_amount NULL → rejected (manual review)', async () => {
    tx.payment.findUnique.mockResolvedValue(
      makePayment({ paymentStatus: PaymentStatus.partially_refunded, capturedAmount: null }),
    );
    await expect(
      service.refund({ paymentId: 'pay-1', amount: 100, reason: REASON, source: 'admin_manual' }),
    ).rejects.toThrow(ConflictException);
    expect(omise.createRefund).not.toHaveBeenCalled();
  });

  it('history row carries source + reason (passed to FSM)', async () => {
    tx.payment.findUnique.mockResolvedValue(makePayment());
    await service.refund({
      paymentId: 'pay-1',
      reason: REASON,
      source: 'payout_exception',
      actorId: 'admin-9',
    });
    expect(fsm.transition).toHaveBeenCalledWith(
      'pay-1',
      expect.any(String),
      expect.objectContaining({
        changedBy: 'admin-9',
        reason: REASON,
        metadata: expect.objectContaining({ source: 'payout_exception', reason: REASON, actorId: 'admin-9' }),
      }),
      tx,
    );
  });
});
