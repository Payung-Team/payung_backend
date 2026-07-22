/**
 * Unit tests สำหรับ PaymentService.refundPayment (PYG-286)
 *
 * ครอบคลุม guard ทั้ง 4 ชั้น (เงินจริง — defense in depth) + happy path + race:
 *  - Role guard (non-admin) → Forbidden
 *  - Status pre-check (not captured / no charge id)
 *  - Amount range (negative, > payment.amount)
 *  - Status re-check before Omise (double-refund race)
 *  - Omise failure → ServiceUnavailable (status ไม่เปลี่ยน)
 *  - Happy path: full refund → 'refunded', partial → 'partially_refunded'
 *  - Idempotency key ส่งไปให้ Omise
 *  - emit BOOKING_EVENTS.REFUND_ISSUED ครั้งเดียว (ไม่ซ้ำ ไม่ bypass listener)
 */
import { Test, TestingModule } from '@nestjs/testing';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { ConfigService } from '@nestjs/config';
import { PaymentService } from './payment.service';
import { PrismaService } from '../common/prisma.service';
import { PaymentStateMachine } from './payment-state-machine';
import { OmiseService } from './omise/omise.service';
import { PaymentStatus } from './entities/payment-status.enum';
import { ROLE_ID } from '../common/constants/roles.constant';
import { AuthUser } from '../common/decorators/current-user.decorator';
import { BOOKING_EVENTS } from '../notification/events/booking-event';

const PAYMENT_ID = 'pay-0001';
const BOOKING_ID = 'book-0001';
const PATIENT_ID = 'patient-0001';
const CAREGIVER_ID = 'cg-0001';
const ADMIN_ID = 'admin-0001';
const CHARGE_ID = 'chrg_test_1';

function fakePayment(overrides: Record<string, unknown> = {}) {
  return {
    id: PAYMENT_ID,
    bookingId: BOOKING_ID,
    patientId: PATIENT_ID,
    caregiverId: CAREGIVER_ID,
    amount: 1200,
    currency: 'THB',
    paymentStatus: 'captured',
    paymentMethod: 'credit_card',
    omiseChargeId: CHARGE_ID,
    metadata: {},
    createdAt: new Date(),
    updatedAt: new Date(),
    failureCode: null,
    failureMessage: null,
    ...overrides,
  };
}

const asUser = (id: string, role: number): AuthUser => ({ id, role } as AuthUser);

describe('PaymentService.refundPayment (PYG-286)', () => {
  let service: PaymentService;

  let prisma: {
    payment: { findUnique: jest.Mock; update: jest.Mock };
    $transaction: jest.Mock;
  };
  let tx: { payment: { update: jest.Mock } };
  let fsm: { transition: jest.Mock };
  let omise: { createRefund: jest.Mock };
  let emitter: { emit: jest.Mock };

  beforeEach(async () => {
    tx = { payment: { update: jest.fn() } };
    prisma = {
      payment: { findUnique: jest.fn(), update: jest.fn() },
      $transaction: jest.fn((cb: (t: typeof tx) => unknown) => cb(tx)),
    };
    fsm = { transition: jest.fn() };
    omise = { createRefund: jest.fn() };
    emitter = { emit: jest.fn() };

    const moduleRef: TestingModule = await Test.createTestingModule({
      providers: [
        PaymentService,
        { provide: PrismaService, useValue: prisma },
        { provide: PaymentStateMachine, useValue: fsm },
        { provide: OmiseService, useValue: omise },
        { provide: EventEmitter2, useValue: emitter },
        { provide: ConfigService, useValue: { get: jest.fn() } },
      ],
    }).compile();

    service = moduleRef.get(PaymentService);
  });

  // ─── Guards ────────────────────────────────────────────────────────────────

  it('non-admin role → ForbiddenException', async () => {
    await expect(
      service.refundPayment(
        { paymentId: PAYMENT_ID },
        asUser('patient-x', ROLE_ID.PATIENT),
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(prisma.payment.findUnique).not.toHaveBeenCalled();
  });

  it('payment ไม่พบ → NotFoundException', async () => {
    prisma.payment.findUnique.mockResolvedValueOnce(null);
    await expect(
      service.refundPayment(
        { paymentId: PAYMENT_ID },
        asUser(ADMIN_ID, ROLE_ID.ADMIN),
      ),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(omise.createRefund).not.toHaveBeenCalled();
  });

  it('payment ไม่ใช่ captured → BadRequestException (ไม่เรียก Omise)', async () => {
    prisma.payment.findUnique.mockResolvedValueOnce(
      fakePayment({ paymentStatus: 'held' }),
    );
    await expect(
      service.refundPayment(
        { paymentId: PAYMENT_ID },
        asUser(ADMIN_ID, ROLE_ID.ADMIN),
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(omise.createRefund).not.toHaveBeenCalled();
  });

  it('payment ไม่มี omiseChargeId → BadRequestException', async () => {
    prisma.payment.findUnique.mockResolvedValueOnce(
      fakePayment({ omiseChargeId: null }),
    );
    await expect(
      service.refundPayment(
        { paymentId: PAYMENT_ID },
        asUser(ADMIN_ID, ROLE_ID.ADMIN),
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(omise.createRefund).not.toHaveBeenCalled();
  });

  it('amount > payment.amount → BadRequestException', async () => {
    prisma.payment.findUnique.mockResolvedValueOnce(fakePayment());
    await expect(
      service.refundPayment(
        { paymentId: PAYMENT_ID, amount: 1500 },
        asUser(ADMIN_ID, ROLE_ID.ADMIN),
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(omise.createRefund).not.toHaveBeenCalled();
  });

  it('status เปลี่ยนระหว่าง pre-check + re-check (double-refund race) → ConflictException', async () => {
    prisma.payment.findUnique
      // pre-check ผ่าน
      .mockResolvedValueOnce(fakePayment())
      // re-check: เปลี่ยนเป็น refunded แล้ว (admin คนอื่น refund ก่อน)
      .mockResolvedValueOnce({ paymentStatus: 'refunded' });

    await expect(
      service.refundPayment(
        { paymentId: PAYMENT_ID },
        asUser(ADMIN_ID, ROLE_ID.ADMIN),
      ),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(omise.createRefund).not.toHaveBeenCalled();
  });

  it('Omise refund fail → ServiceUnavailableException (status ไม่เปลี่ยน, ไม่ emit)', async () => {
    prisma.payment.findUnique
      .mockResolvedValueOnce(fakePayment())
      .mockResolvedValueOnce({ paymentStatus: 'captured' });
    omise.createRefund.mockRejectedValueOnce(new Error('Omise 503'));

    await expect(
      service.refundPayment(
        { paymentId: PAYMENT_ID },
        asUser(ADMIN_ID, ROLE_ID.ADMIN),
      ),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(fsm.transition).not.toHaveBeenCalled();
    expect(emitter.emit).not.toHaveBeenCalled();
  });

  // ─── Happy paths ───────────────────────────────────────────────────────────

  it('full refund: captured → refunded, ไม่ส่ง amount ไปให้ Omise, ส่ง idempotency key', async () => {
    prisma.payment.findUnique
      .mockResolvedValueOnce(fakePayment())
      .mockResolvedValueOnce({ paymentStatus: 'captured' });
    omise.createRefund.mockResolvedValueOnce({
      id: 'rfnd_test_1',
      amount: 120000,
      charge: CHARGE_ID,
      currency: 'THB',
      voided: false,
    });
    fsm.transition.mockResolvedValueOnce(fakePayment({ paymentStatus: 'refunded' }));
    tx.payment.update.mockResolvedValueOnce(
      fakePayment({ paymentStatus: 'refunded', metadata: { omiseRefundId: 'rfnd_test_1' } }),
    );

    await service.refundPayment(
      { paymentId: PAYMENT_ID, reason: 'service not delivered' },
      asUser(ADMIN_ID, ROLE_ID.ADMIN),
    );

    // Omise: full = undefined amount, key = refund:{paymentId}:{satangs}
    expect(omise.createRefund).toHaveBeenCalledWith(
      CHARGE_ID,
      undefined,
      `refund:${PAYMENT_ID}:120000`, // 1200 THB = 120000 satangs
    );

    // FSM: captured → refunded ใน tx เดียวกัน
    expect(fsm.transition).toHaveBeenCalledWith(
      PAYMENT_ID,
      PaymentStatus.refunded,
      expect.objectContaining({
        changedBy: ADMIN_ID,
        reason: 'service not delivered',
        metadata: expect.objectContaining({
          omiseRefundId: 'rfnd_test_1',
          isPartial: false,
        }),
      }),
      tx,
    );

    // emit REFUND_ISSUED ครั้งเดียว (ไม่ bypass listener)
    expect(emitter.emit).toHaveBeenCalledTimes(1);
    expect(emitter.emit).toHaveBeenCalledWith(
      BOOKING_EVENTS.REFUND_ISSUED,
      expect.objectContaining({
        bookingId: BOOKING_ID,
        patientId: PATIENT_ID,
        metadata: expect.objectContaining({ isPartial: false }),
      }),
    );
  });

  it('partial refund: amount=500 → partially_refunded, ส่ง amount satangs ไปให้ Omise', async () => {
    prisma.payment.findUnique
      .mockResolvedValueOnce(fakePayment())
      .mockResolvedValueOnce({ paymentStatus: 'captured' });
    omise.createRefund.mockResolvedValueOnce({
      id: 'rfnd_test_2',
      amount: 50000,
      charge: CHARGE_ID,
      currency: 'THB',
      voided: false,
    });
    fsm.transition.mockResolvedValueOnce(
      fakePayment({ paymentStatus: 'partially_refunded' }),
    );
    tx.payment.update.mockResolvedValueOnce(
      fakePayment({ paymentStatus: 'partially_refunded' }),
    );

    await service.refundPayment(
      { paymentId: PAYMENT_ID, amount: 500 },
      asUser(ADMIN_ID, ROLE_ID.ADMIN),
    );

    expect(omise.createRefund).toHaveBeenCalledWith(
      CHARGE_ID,
      50000, // 500 THB = 50000 satangs
      `refund:${PAYMENT_ID}:50000`,
    );
    expect(fsm.transition).toHaveBeenCalledWith(
      PAYMENT_ID,
      PaymentStatus.partially_refunded,
      expect.objectContaining({
        metadata: expect.objectContaining({ isPartial: true, refundAmount: 500 }),
      }),
      tx,
    );
    expect(emitter.emit).toHaveBeenCalledWith(
      BOOKING_EVENTS.REFUND_ISSUED,
      expect.objectContaining({
        metadata: expect.objectContaining({ isPartial: true, amount: 500 }),
      }),
    );
  });
});

// ─── PYG-278: findByBookingId ───────────────────────────────────────────────

describe('PaymentService.findByBookingId (PYG-278)', () => {
  let service: PaymentService;
  let prisma: { payment: { findUnique: jest.Mock } };

  beforeEach(async () => {
    prisma = { payment: { findUnique: jest.fn() } };

    const moduleRef: TestingModule = await Test.createTestingModule({
      providers: [
        PaymentService,
        { provide: PrismaService, useValue: prisma },
        { provide: PaymentStateMachine, useValue: { transition: jest.fn() } },
        { provide: OmiseService, useValue: { createRefund: jest.fn() } },
        { provide: EventEmitter2, useValue: { emit: jest.fn() } },
        { provide: ConfigService, useValue: { get: jest.fn() } },
      ],
    }).compile();

    service = moduleRef.get(PaymentService);
  });

  it('มี payment record → คืน Payment object (amount เป็น number)', async () => {
    const row = fakePayment({ amount: { toNumber: () => 1140 } });
    prisma.payment.findUnique.mockResolvedValueOnce(row);

    const result = await service.findByBookingId(BOOKING_ID);

    expect(prisma.payment.findUnique).toHaveBeenCalledWith({ where: { bookingId: BOOKING_ID } });
    expect(result).not.toBeNull();
    expect(result!.id).toBe(PAYMENT_ID);
    expect(typeof result!.amount).toBe('number');
    expect(result!.amount).toBe(1140);
    expect(result!.paymentStatus).toBe('captured');
  });

  it('ไม่มี payment record → คืน null', async () => {
    prisma.payment.findUnique.mockResolvedValueOnce(null);

    const result = await service.findByBookingId(BOOKING_ID);

    expect(prisma.payment.findUnique).toHaveBeenCalledWith({ where: { bookingId: BOOKING_ID } });
    expect(result).toBeNull();
  });
});

// ─── PYG-266: transferPaymentToCaregiver ────────────────────────────────────

describe('PaymentService.transferPaymentToCaregiver (PYG-266)', () => {
  let service: PaymentService;

  let prisma: {
    payment: { findUnique: jest.Mock; update: jest.Mock };
    caregiver: { findUnique: jest.Mock };
    caregiverPayoutAccount: { findUnique: jest.Mock };
    $transaction: jest.Mock;
  };
  let tx: { payment: { update: jest.Mock } };
  let fsm: { transition: jest.Mock; recordCaptureFailure: jest.Mock };
  let omise: { createTransfer: jest.Mock };
  let emitter: { emit: jest.Mock };
  let config: { get: jest.Mock };

  const caregiverRow = () => ({
    id: 'cgrow-1',
    userId: CAREGIVER_ID,
    fullName: 'สมชาย ใจดี',
    user: { isActive: true, is_suspended: false, is_deleted: false },
  });

  const payoutAccount = (overrides: Record<string, unknown> = {}) => ({
    id: 'payout-1',
    caregiverId: 'cgrow-1',
    status: 'active',
    recipientStatus: 'verified',
    omiseRecipientId: 'recp_test_1',
    ...overrides,
  });

  beforeEach(async () => {
    tx = { payment: { update: jest.fn() } };
    prisma = {
      payment: { findUnique: jest.fn(), update: jest.fn() },
      caregiver: { findUnique: jest.fn() },
      caregiverPayoutAccount: { findUnique: jest.fn() },
      $transaction: jest.fn((cb: (t: typeof tx) => unknown) => cb(tx)),
    };
    fsm = { transition: jest.fn(), recordCaptureFailure: jest.fn() };
    omise = { createTransfer: jest.fn() };
    emitter = { emit: jest.fn() };
    // ConfigService.get<T>() ไม่ coerce ให้เป็นเลขจริง — จำลอง env จริงที่คืน string เสมอ
    // เพื่อทดสอบว่า service ทำ Number() เอง (ไม่งั้น platformFeePercent จะเป็น "10" ไม่ใช่ 10)
    config = { get: jest.fn().mockReturnValue('10') };

    const moduleRef: TestingModule = await Test.createTestingModule({
      providers: [
        PaymentService,
        { provide: PrismaService, useValue: prisma },
        { provide: PaymentStateMachine, useValue: fsm },
        { provide: OmiseService, useValue: omise },
        { provide: EventEmitter2, useValue: emitter },
        { provide: ConfigService, useValue: config },
      ],
    }).compile();

    service = moduleRef.get(PaymentService);
  });

  it('non-admin role → ForbiddenException', async () => {
    await expect(
      service.transferPaymentToCaregiver(BOOKING_ID, asUser('patient-x', ROLE_ID.PATIENT)),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(prisma.payment.findUnique).not.toHaveBeenCalled();
  });

  it('ไม่พบ payment ของ booking นี้ → NotFoundException', async () => {
    prisma.payment.findUnique.mockResolvedValueOnce(null);
    await expect(
      service.transferPaymentToCaregiver(BOOKING_ID, asUser(ADMIN_ID, ROLE_ID.ADMIN)),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('payment ไม่ใช่ captured → BadRequestException', async () => {
    prisma.payment.findUnique.mockResolvedValueOnce(fakePayment({ paymentStatus: 'held' }));
    await expect(
      service.transferPaymentToCaregiver(BOOKING_ID, asUser(ADMIN_ID, ROLE_ID.ADMIN)),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(omise.createTransfer).not.toHaveBeenCalled();
  });

  it('payment.metadata มี omiseTransferId อยู่แล้ว (โอนไปแล้ว) → ConflictException', async () => {
    prisma.payment.findUnique.mockResolvedValueOnce(
      fakePayment({ metadata: { omiseTransferId: 'trsf_already' } }),
    );
    await expect(
      service.transferPaymentToCaregiver(BOOKING_ID, asUser(ADMIN_ID, ROLE_ID.ADMIN)),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(omise.createTransfer).not.toHaveBeenCalled();
  });

  it('caregiver ถูกระงับบัญชี (is_suspended) → BadRequestException', async () => {
    prisma.payment.findUnique.mockResolvedValueOnce(fakePayment());
    prisma.caregiver.findUnique.mockResolvedValueOnce({
      ...caregiverRow(),
      user: { isActive: true, is_suspended: true, is_deleted: false },
    });
    await expect(
      service.transferPaymentToCaregiver(BOOKING_ID, asUser(ADMIN_ID, ROLE_ID.ADMIN)),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(omise.createTransfer).not.toHaveBeenCalled();
  });

  it('ไม่มีบัญชีรับเงิน (payout account) → BadRequestException', async () => {
    prisma.payment.findUnique.mockResolvedValueOnce(fakePayment());
    prisma.caregiver.findUnique.mockResolvedValueOnce(caregiverRow());
    prisma.caregiverPayoutAccount.findUnique.mockResolvedValueOnce(null);
    await expect(
      service.transferPaymentToCaregiver(BOOKING_ID, asUser(ADMIN_ID, ROLE_ID.ADMIN)),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(omise.createTransfer).not.toHaveBeenCalled();
  });

  it('recipientStatus ยังไม่ verified → BadRequestException', async () => {
    prisma.payment.findUnique.mockResolvedValueOnce(fakePayment());
    prisma.caregiver.findUnique.mockResolvedValueOnce(caregiverRow());
    prisma.caregiverPayoutAccount.findUnique.mockResolvedValueOnce(
      payoutAccount({ recipientStatus: 'unverified' }),
    );
    await expect(
      service.transferPaymentToCaregiver(BOOKING_ID, asUser(ADMIN_ID, ROLE_ID.ADMIN)),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(omise.createTransfer).not.toHaveBeenCalled();
  });

  it('re-check ก่อนยิง Omise เจอว่า payout account ถูก webhook เปลี่ยนเป็น failed → ConflictException', async () => {
    prisma.payment.findUnique
      .mockResolvedValueOnce(fakePayment()) // pre-check
      .mockResolvedValueOnce({ paymentStatus: 'captured', metadata: {} }); // re-check
    prisma.caregiver.findUnique.mockResolvedValueOnce(caregiverRow());
    prisma.caregiverPayoutAccount.findUnique
      .mockResolvedValueOnce(payoutAccount()) // guard 5
      .mockResolvedValueOnce({ status: 'active', recipientStatus: 'failed' }); // guard 6 re-check

    await expect(
      service.transferPaymentToCaregiver(BOOKING_ID, asUser(ADMIN_ID, ROLE_ID.ADMIN)),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(omise.createTransfer).not.toHaveBeenCalled();
  });

  it('Omise createTransfer ล้มเหลว → ServiceUnavailableException, บันทึก audit, ไม่เปลี่ยนสถานะ', async () => {
    prisma.payment.findUnique
      .mockResolvedValueOnce(fakePayment())
      .mockResolvedValueOnce({ paymentStatus: 'captured', metadata: {} });
    prisma.caregiver.findUnique.mockResolvedValueOnce(caregiverRow());
    prisma.caregiverPayoutAccount.findUnique
      .mockResolvedValueOnce(payoutAccount())
      .mockResolvedValueOnce({ status: 'active', recipientStatus: 'verified' });
    omise.createTransfer.mockRejectedValueOnce(new Error('Omise down'));

    await expect(
      service.transferPaymentToCaregiver(BOOKING_ID, asUser(ADMIN_ID, ROLE_ID.ADMIN)),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);

    expect(fsm.transition).not.toHaveBeenCalled();
    expect(fsm.recordCaptureFailure).toHaveBeenCalledWith(
      PAYMENT_ID,
      PaymentStatus.captured,
      expect.objectContaining({ changedBy: ADMIN_ID }),
    );
    expect(emitter.emit).not.toHaveBeenCalled();
  });

  it('happy path: โอน 90% ของยอด captured (fee 10%), fsm.transition + emit ครั้งเดียว', async () => {
    prisma.payment.findUnique
      .mockResolvedValueOnce(fakePayment()) // amount = 1200
      .mockResolvedValueOnce({ paymentStatus: 'captured', metadata: {} });
    prisma.caregiver.findUnique.mockResolvedValueOnce(caregiverRow());
    prisma.caregiverPayoutAccount.findUnique
      .mockResolvedValueOnce(payoutAccount())
      .mockResolvedValueOnce({ status: 'active', recipientStatus: 'verified' });
    omise.createTransfer.mockResolvedValueOnce({
      id: 'trsf_test_1',
      amount: 108000,
      recipient: 'recp_test_1',
    });
    fsm.transition.mockResolvedValueOnce(fakePayment({ paymentStatus: 'transferred', metadata: {} }));
    tx.payment.update.mockResolvedValueOnce(
      fakePayment({ paymentStatus: 'transferred', metadata: { omiseTransferId: 'trsf_test_1' } }),
    );

    await service.transferPaymentToCaregiver(BOOKING_ID, asUser(ADMIN_ID, ROLE_ID.ADMIN));

    // 1200 THB = 120000 satangs; fee 10% → transfer 108000 satangs (90%)
    expect(omise.createTransfer).toHaveBeenCalledWith(
      'recp_test_1',
      108000,
      `transfer:${PAYMENT_ID}`,
    );

    expect(fsm.transition).toHaveBeenCalledWith(
      PAYMENT_ID,
      PaymentStatus.transferred,
      expect.objectContaining({
        changedBy: ADMIN_ID,
        metadata: expect.objectContaining({
          omiseTransferId: 'trsf_test_1',
          platformFeePercent: 10,
          transferAmountSatangs: 108000,
        }),
      }),
      tx,
    );

    expect(emitter.emit).toHaveBeenCalledTimes(1);
    expect(emitter.emit).toHaveBeenCalledWith(
      BOOKING_EVENTS.PAYMENT_TRANSFERRED,
      expect.objectContaining({
        bookingId: BOOKING_ID,
        caregiverId: CAREGIVER_ID,
        metadata: expect.objectContaining({
          transferAmountSatangs: 108000,
          omiseTransferId: 'trsf_test_1',
        }),
      }),
    );

    // platformFeePercent เก็บเป็น number จริง ไม่ใช่ string "10" (ConfigService.get ไม่ coerce เอง)
    const metadataArg = fsm.transition.mock.calls[0][2].metadata;
    expect(typeof metadataArg.platformFeePercent).toBe('number');
  });

  it('กดโอนซ้ำ (double-submit): omiseTransferId ที่ metadata กันไม่ให้ยิง Omise ซ้ำ', async () => {
    // ครั้งแรก: สำเร็จ (โอนแล้ว, metadata มี omiseTransferId)
    // ครั้งที่สอง: pre-check เจอ omiseTransferId ใน metadata แล้ว → ConflictException ก่อนเรียก Omise เลย
    prisma.payment.findUnique.mockResolvedValueOnce(
      fakePayment({ metadata: { omiseTransferId: 'trsf_test_1' } }),
    );

    await expect(
      service.transferPaymentToCaregiver(BOOKING_ID, asUser(ADMIN_ID, ROLE_ID.ADMIN)),
    ).rejects.toBeInstanceOf(ConflictException);

    expect(omise.createTransfer).not.toHaveBeenCalled();
  });
});
