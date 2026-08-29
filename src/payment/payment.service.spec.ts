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
import { RefundService } from './refund.service';
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

describe('PaymentService.refundPayment (PYG-374 — thin wrapper over RefundService)', () => {
  let service: PaymentService;
  let refundService: { refund: jest.Mock };

  beforeEach(async () => {
    // PYG-374: refund core moved to RefundService. Guard behaviour is tested in
    // refund.service.spec.ts — here we only assert the wrapper's role guard + delegation.
    refundService = {
      refund: jest.fn().mockResolvedValue(fakePayment({ paymentStatus: 'refunded' })),
    };

    const moduleRef: TestingModule = await Test.createTestingModule({
      providers: [
        PaymentService,
        {
          provide: PrismaService,
          useValue: { payment: { findUnique: jest.fn(), update: jest.fn() } },
        },
        { provide: PaymentStateMachine, useValue: { transition: jest.fn() } },
        { provide: OmiseService, useValue: { createRefund: jest.fn() } },
        { provide: EventEmitter2, useValue: { emit: jest.fn() } },
        { provide: RefundService, useValue: refundService },
        { provide: ConfigService, useValue: { get: jest.fn() } },
      ],
    }).compile();

    service = moduleRef.get(PaymentService);
  });

  it('non-admin role → ForbiddenException (ไม่แตะ RefundService)', async () => {
    await expect(
      service.refundPayment(
        { paymentId: PAYMENT_ID, reason: 'valid refund reason' },
        asUser('patient-x', ROLE_ID.PATIENT),
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(refundService.refund).not.toHaveBeenCalled();
  });

  it('admin partial → delegates to RefundService (source=admin_manual + actorId + amount + reason)', async () => {
    await service.refundPayment(
      { paymentId: PAYMENT_ID, amount: 500, reason: 'service not delivered' },
      asUser(ADMIN_ID, ROLE_ID.ADMIN),
    );
    expect(refundService.refund).toHaveBeenCalledWith({
      paymentId: PAYMENT_ID,
      amount: 500,
      reason: 'service not delivered',
      source: 'admin_manual',
      actorId: ADMIN_ID,
    });
  });

  it('admin full refund (no amount) → delegates with amount undefined', async () => {
    await service.refundPayment(
      { paymentId: PAYMENT_ID, reason: 'service not delivered' },
      asUser(ADMIN_ID, ROLE_ID.ADMIN),
    );
    expect(refundService.refund).toHaveBeenCalledWith(
      expect.objectContaining({
        paymentId: PAYMENT_ID,
        amount: undefined,
        source: 'admin_manual',
      }),
    );
  });
});

// ─── createPayment — duplicate-payment guard (retry after failed attempt) ───

describe('PaymentService.createPayment — duplicate guard', () => {
  let service: PaymentService;
  let prisma: {
    booking: { findUnique: jest.Mock };
    payment: { findUnique: jest.Mock };
  };
  let omise: { createCharge: jest.Mock };

  const acceptedBooking = {
    id: BOOKING_ID,
    patientId: PATIENT_ID,
    status: 'accepted',
    durationHours: 2,
    caregiverId: CAREGIVER_ID,
    caregiver: { userId: CAREGIVER_ID, hourlyRate: 550 },
  };

  // sentinel error thrown by createCharge — reaching it proves the guard let us through
  const CHARGE_REACHED = new Error('__charge_reached__');

  const cardInput = {
    bookingId: BOOKING_ID,
    paymentMethod: 'credit_card',
    omiseToken: 'tokn_test_1',
  };

  beforeEach(async () => {
    prisma = {
      booking: { findUnique: jest.fn().mockResolvedValue(acceptedBooking) },
      payment: { findUnique: jest.fn() },
    };
    omise = { createCharge: jest.fn().mockRejectedValue(CHARGE_REACHED) };

    const moduleRef: TestingModule = await Test.createTestingModule({
      providers: [
        PaymentService,
        { provide: PrismaService, useValue: prisma },
        { provide: PaymentStateMachine, useValue: { transition: jest.fn() } },
        { provide: OmiseService, useValue: omise },
        { provide: EventEmitter2, useValue: { emit: jest.fn() } },
        { provide: RefundService, useValue: { refund: jest.fn() } },
      ],
    }).compile();

    service = moduleRef.get(PaymentService);
  });

  const patient = asUser(PATIENT_ID, ROLE_ID.PATIENT);

  it('no existing payment → passes guard (reaches createCharge)', async () => {
    prisma.payment.findUnique.mockResolvedValueOnce(null);
    await expect(service.createPayment(cardInput, patient)).rejects.toBe(CHARGE_REACHED);
    expect(omise.createCharge).toHaveBeenCalledTimes(1);
  });

  // Retryable states — a payment that never actually secured funds must not block a new attempt
  it.each([
    PaymentStatus.failed,
    PaymentStatus.expired,
    PaymentStatus.voided,
  ])('existing payment in %s → allows retry (reaches createCharge)', async (status) => {
    prisma.payment.findUnique.mockResolvedValueOnce(
      fakePayment({ paymentStatus: status }),
    );
    await expect(service.createPayment(cardInput, patient)).rejects.toBe(CHARGE_REACHED);
    expect(omise.createCharge).toHaveBeenCalledTimes(1);
  });

  // Valid/in-progress states — block to prevent double payment / duplicate Omise charge.
  // (pending here uses fakePayment's fresh updatedAt → treated as an in-flight QR)
  it.each([
    PaymentStatus.pending,
    PaymentStatus.held,
    PaymentStatus.captured,
    PaymentStatus.transferred,
    PaymentStatus.refunded,
    PaymentStatus.partially_refunded,
  ])('existing payment in %s → ConflictException (never reaches createCharge)', async (status) => {
    prisma.payment.findUnique.mockResolvedValueOnce(
      fakePayment({ paymentStatus: status }),
    );
    await expect(service.createPayment(cardInput, patient)).rejects.toBeInstanceOf(
      ConflictException,
    );
    expect(omise.createCharge).not.toHaveBeenCalled();
  });

  it('fresh pending (just created) → blocks (guards double-charge with in-flight QR)', async () => {
    prisma.payment.findUnique.mockResolvedValueOnce(
      fakePayment({ paymentStatus: PaymentStatus.pending, updatedAt: new Date() }),
    );
    await expect(service.createPayment(cardInput, patient)).rejects.toBeInstanceOf(
      ConflictException,
    );
    expect(omise.createCharge).not.toHaveBeenCalled();
  });

  it('stale pending (abandoned QR, >15m old) → allows retry (reaches createCharge)', async () => {
    const staleUpdatedAt = new Date(Date.now() - 16 * 60 * 1000); // 16 min ago
    prisma.payment.findUnique.mockResolvedValueOnce(
      fakePayment({ paymentStatus: PaymentStatus.pending, updatedAt: staleUpdatedAt }),
    );
    await expect(service.createPayment(cardInput, patient)).rejects.toBe(CHARGE_REACHED);
    expect(omise.createCharge).toHaveBeenCalledTimes(1);
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
        { provide: RefundService, useValue: { refund: jest.fn() } },
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

// ─── createPayment — PYG-309/375: reconcile stale PromptPay + failed-record on decline ───

describe('PaymentService.createPayment — PYG-309 reconcile + failed record', () => {
  let service: PaymentService;
  let prisma: {
    booking: { findUnique: jest.Mock };
    payment: { findUnique: jest.Mock; create: jest.Mock; update: jest.Mock };
    paymentStatusHistory: { create: jest.Mock };
    $transaction: jest.Mock;
  };
  let omise: { createCharge: jest.Mock; retrieveCharge: jest.Mock };
  let fsm: { transition: jest.Mock; recordInitialStatus: jest.Mock };

  const acceptedBooking = {
    id: BOOKING_ID,
    patientId: PATIENT_ID,
    status: 'accepted',
    durationHours: 2,
    caregiverId: CAREGIVER_ID,
    caregiver: { userId: CAREGIVER_ID, hourlyRate: 550 },
  };
  const patient = asUser(PATIENT_ID, ROLE_ID.PATIENT);
  const cardInput = { bookingId: BOOKING_ID, paymentMethod: 'credit_card', omiseToken: 'tokn_1' };

  beforeEach(async () => {
    prisma = {
      booking: { findUnique: jest.fn().mockResolvedValue(acceptedBooking) },
      payment: { findUnique: jest.fn(), create: jest.fn(), update: jest.fn() },
      paymentStatusHistory: { create: jest.fn() },
      $transaction: jest.fn(),
    };
    omise = { createCharge: jest.fn(), retrieveCharge: jest.fn() };
    fsm = { transition: jest.fn(), recordInitialStatus: jest.fn() };

    const moduleRef: TestingModule = await Test.createTestingModule({
      providers: [
        PaymentService,
        { provide: PrismaService, useValue: prisma },
        { provide: PaymentStateMachine, useValue: fsm },
        { provide: OmiseService, useValue: omise },
        { provide: EventEmitter2, useValue: { emit: jest.fn() } },
        { provide: RefundService, useValue: { refund: jest.fn() } },
      ],
    }).compile();
    service = moduleRef.get(PaymentService);
  });

  it('PromptPay pending + Omise says paid (webhook lost) → captured, NO second charge', async () => {
    prisma.payment.findUnique.mockResolvedValue(
      fakePayment({ paymentStatus: 'pending', paymentMethod: 'promptpay' }),
    );
    omise.retrieveCharge.mockResolvedValue({ paid: true });
    fsm.transition.mockResolvedValue(fakePayment({ paymentStatus: 'captured' }));

    const result = await service.createPayment(cardInput, patient);

    expect(omise.retrieveCharge).toHaveBeenCalledTimes(1); // asked Omise FIRST
    expect(fsm.transition).toHaveBeenCalledWith(PAYMENT_ID, PaymentStatus.captured, expect.anything());
    expect(omise.createCharge).not.toHaveBeenCalled(); // did NOT charge again
    expect(result.paymentStatus).toBe('captured');
  });

  it('PromptPay pending + Omise says not paid → expired, then retry proceeds to createCharge', async () => {
    prisma.payment.findUnique.mockResolvedValue(
      fakePayment({ paymentStatus: 'pending', paymentMethod: 'promptpay' }),
    );
    omise.retrieveCharge.mockResolvedValue({ paid: false, expiresAt: '2026-08-01T00:00:00Z' });
    fsm.transition.mockResolvedValue(fakePayment({ paymentStatus: 'expired' }));
    const CHARGE_REACHED = new Error('__charge_reached__');
    omise.createCharge.mockRejectedValue(CHARGE_REACHED);

    await expect(service.createPayment(cardInput, patient)).rejects.toBe(CHARGE_REACHED);
    expect(fsm.transition).toHaveBeenCalledWith(PAYMENT_ID, PaymentStatus.expired, expect.anything());
    expect(omise.createCharge).toHaveBeenCalledTimes(1); // not blocked → retry proceeded
  });

  it('declined card (no existing) → writes a `failed` row + rethrows the same error', async () => {
    prisma.payment.findUnique.mockResolvedValue(null);
    const declined = Object.assign(new Error('card was declined'), {
      details: { omiseCode: 'insufficient_fund', omiseMessage: 'insufficient funds' },
    });
    omise.createCharge.mockRejectedValue(declined);
    prisma.payment.create.mockResolvedValue({ id: 'pay-new' });

    await expect(service.createPayment(cardInput, patient)).rejects.toBe(declined);

    expect(prisma.payment.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          paymentStatus: PaymentStatus.failed,
          failureCode: 'insufficient_fund',
        }),
      }),
    );
    expect(fsm.recordInitialStatus).toHaveBeenCalledWith(
      'pay-new',
      PaymentStatus.failed,
      expect.anything(),
    );
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
