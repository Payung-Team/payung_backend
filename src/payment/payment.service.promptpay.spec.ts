/**
 * PaymentService — PromptPay flow tests (PYG-278)
 *
 * ครอบคลุม:
 *  - createPayment(paymentMethod='promptpay') → finalisePromptPay → pending + qrCodeUrl
 *  - captureFromWebhook → pending → captured + emit CONFIRMED
 *  - captureFromWebhook idempotent (skip ถ้า payment ไม่ใช่ pending)
 *  - captureFromWebhook re-verifies via retrieveCharge (กัน tampered webhook)
 *  - paymentByBooking polling fallback → retrieve → reconcile ถ้า paid
 *  - paymentByBooking authorization (party / admin only)
 *  - card flow ไม่ถูกแตะ (sanity check)
 */
import { Test, TestingModule } from '@nestjs/testing';
import { ForbiddenException, UnprocessableEntityException } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { PaymentService } from './payment.service';
import { PrismaService } from '../common/prisma.service';
import { PaymentStateMachine } from './payment-state-machine';
import { OmiseService } from './omise/omise.service';
import { PaymentStatus } from './entities/payment-status.enum';
import { ROLE_ID } from '../common/constants/roles.constant';
import { AuthUser } from '../common/decorators/current-user.decorator';
import { BOOKING_EVENTS } from '../notification/events/booking-event';
import { CreatePaymentInput } from './dto/create-payment.input';

const BOOKING_ID = 'book-0001';
const PAYMENT_ID = 'pay-0001';
const PATIENT_ID = 'patient-0001';
const CAREGIVER_USER_ID = 'cg-user-0001';
const CHARGE_ID = 'chrg_test_promptpay';
const QR_URL = 'https://api.omise.co/charges/chrg_x/qr.png';

const asUser = (id: string, role: number): AuthUser => ({ id, role } as AuthUser);

function fakeBooking(overrides: Record<string, unknown> = {}) {
  return {
    id: BOOKING_ID,
    patientId: PATIENT_ID,
    status: 'accepted',
    caregiverId: 'cg-profile-0001',
    caregiver: {
      id: 'cg-profile-0001',
      userId: CAREGIVER_USER_ID,
      hourlyRate: 300,
    },
    durationHours: { toNumber: () => 4 },
    ...overrides,
  };
}

function fakePromptPayPayment(overrides: Record<string, unknown> = {}) {
  return {
    id: PAYMENT_ID,
    bookingId: BOOKING_ID,
    patientId: PATIENT_ID,
    caregiverId: CAREGIVER_USER_ID,
    amount: 1200,
    currency: 'THB',
    paymentStatus: 'pending',
    paymentMethod: 'promptpay',
    omiseChargeId: CHARGE_ID,
    metadata: { qrCodeUrl: QR_URL, amountSatangs: 120000 },
    createdAt: new Date(),
    updatedAt: new Date(),
    failureCode: null,
    failureMessage: null,
    ...overrides,
  };
}

describe('PaymentService — PromptPay (PYG-278)', () => {
  let service: PaymentService;
  let prisma: {
    booking: { findUnique: jest.Mock; update: jest.Mock };
    payment: { findUnique: jest.Mock; findFirst: jest.Mock; create: jest.Mock; update: jest.Mock };
    paymentStatusHistory: { create: jest.Mock };
    $transaction: jest.Mock;
  };
  let tx: typeof prisma;
  let fsm: { transition: jest.Mock };
  let omise: {
    createCharge: jest.Mock;
    createPromptPayCharge: jest.Mock;
    retrieveCharge: jest.Mock;
  };
  let emitter: { emit: jest.Mock };

  beforeEach(async () => {
    tx = {
      booking: { findUnique: jest.fn(), update: jest.fn() },
      payment: {
        findUnique: jest.fn(),
        findFirst: jest.fn(),
        create: jest.fn(),
        update: jest.fn(),
      },
      paymentStatusHistory: { create: jest.fn() },
      $transaction: jest.fn(),
    };
    prisma = {
      booking: { findUnique: jest.fn(), update: jest.fn() },
      payment: {
        findUnique: jest.fn(),
        findFirst: jest.fn(),
        create: jest.fn(),
        update: jest.fn(),
      },
      paymentStatusHistory: { create: jest.fn() },
      $transaction: jest.fn((cb: (t: typeof tx) => unknown) => cb(tx)),
    };
    fsm = { transition: jest.fn().mockResolvedValue({}) };
    omise = {
      createCharge: jest.fn(),
      createPromptPayCharge: jest.fn(),
      retrieveCharge: jest.fn(),
    };
    emitter = { emit: jest.fn() };

    const moduleRef: TestingModule = await Test.createTestingModule({
      providers: [
        PaymentService,
        { provide: PrismaService, useValue: prisma },
        { provide: PaymentStateMachine, useValue: fsm },
        { provide: OmiseService, useValue: omise },
        { provide: EventEmitter2, useValue: emitter },
      ],
    }).compile();

    service = moduleRef.get(PaymentService);
  });

  // ─── createPayment(paymentMethod='promptpay') ──────────────────────────

  describe('createPayment → PromptPay branch', () => {
    it('สร้าง PromptPay charge + payment เป็น pending + qrCodeUrl ใน metadata', async () => {
      prisma.booking.findUnique.mockResolvedValue(fakeBooking());
      prisma.payment.findUnique.mockResolvedValue(null);
      omise.createPromptPayCharge.mockResolvedValue({
        id: CHARGE_ID,
        status: 'pending',
        amount: 120000,
        captured: false,
        paid: false,
        authorized: false,
        qrCodeUrl: QR_URL,
      });
      tx.payment.create.mockResolvedValue(fakePromptPayPayment());

      const input: CreatePaymentInput = {
        bookingId: BOOKING_ID,
        paymentMethod: 'promptpay',
        // ไม่มี omiseToken (PromptPay ไม่ต้อง)
      };

      const result = await service.createPayment(input, asUser(PATIENT_ID, ROLE_ID.PATIENT));

      // ใช้ createPromptPayCharge — ไม่ใช่ createCharge
      expect(omise.createPromptPayCharge).toHaveBeenCalledWith(120000);
      expect(omise.createCharge).not.toHaveBeenCalled();

      // payment สร้างเป็น pending + paymentMethod=promptpay
      expect(tx.payment.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            paymentStatus: PaymentStatus.pending,
            paymentMethod: 'promptpay',
            omiseChargeId: CHARGE_ID,
            metadata: expect.objectContaining({ qrCodeUrl: QR_URL }),
          }),
        }),
      );

      // ❌ ไม่ update booking (ยังคงเป็น accepted จนกว่า webhook จะ confirm)
      expect(tx.booking.update).not.toHaveBeenCalled();

      // ❌ ไม่ emit event ที่นี่ (รอ webhook)
      expect(emitter.emit).not.toHaveBeenCalled();

      // qrCodeUrl exposed ใน response
      expect(result.qrCodeUrl).toBe(QR_URL);
      expect(result.paymentMethod).toBe('promptpay');
    });

    it('credit_card ที่ไม่มี omiseToken → 422', async () => {
      prisma.booking.findUnique.mockResolvedValue(fakeBooking());
      prisma.payment.findUnique.mockResolvedValue(null);

      const input: CreatePaymentInput = {
        bookingId: BOOKING_ID,
        paymentMethod: 'credit_card',
        // omiseToken missing — DTO @ValidateIf bypassed in unit test; service guard catches
      };

      await expect(
        service.createPayment(input, asUser(PATIENT_ID, ROLE_ID.PATIENT)),
      ).rejects.toBeInstanceOf(UnprocessableEntityException);
      expect(omise.createPromptPayCharge).not.toHaveBeenCalled();
    });
  });

  // ─── captureFromWebhook ────────────────────────────────────────────────

  describe('captureFromWebhook', () => {
    it('pending → captured + emit CONFIRMED + booking → confirmed', async () => {
      prisma.payment.findFirst.mockResolvedValue(fakePromptPayPayment());
      omise.retrieveCharge.mockResolvedValue({
        id: CHARGE_ID,
        status: 'successful',
        amount: 120000,
        captured: true,
        paid: true,
        authorized: true,
      });

      await service.captureFromWebhook(CHARGE_ID);

      // FSM transition (passed tx)
      expect(fsm.transition).toHaveBeenCalledWith(
        PAYMENT_ID,
        PaymentStatus.captured,
        expect.objectContaining({
          metadata: expect.objectContaining({
            omiseChargeId: CHARGE_ID,
            source: 'webhook',
          }),
        }),
        expect.anything(),
      );
      expect(tx.booking.update).toHaveBeenCalledWith({
        where: { id: BOOKING_ID },
        data: { status: 'confirmed', confirmedAt: expect.any(Date) },
      });
      expect(emitter.emit).toHaveBeenCalledTimes(1);
      expect(emitter.emit).toHaveBeenCalledWith(
        BOOKING_EVENTS.CONFIRMED,
        expect.objectContaining({
          bookingId: BOOKING_ID,
          patientId: PATIENT_ID,
          caregiverId: CAREGIVER_USER_ID,
        }),
      );
    });

    it('idempotent — payment ที่ไม่ใช่ pending แล้ว → skip (no FSM call)', async () => {
      prisma.payment.findFirst.mockResolvedValue(
        fakePromptPayPayment({ paymentStatus: 'captured' }),
      );

      await service.captureFromWebhook(CHARGE_ID);

      expect(omise.retrieveCharge).not.toHaveBeenCalled();
      expect(fsm.transition).not.toHaveBeenCalled();
      expect(emitter.emit).not.toHaveBeenCalled();
    });

    it('re-fetch จาก Omise — ถ้า charge ไม่ successful → skip', async () => {
      prisma.payment.findFirst.mockResolvedValue(fakePromptPayPayment());
      omise.retrieveCharge.mockResolvedValue({
        id: CHARGE_ID,
        status: 'pending',
        amount: 120000,
        captured: false,
        paid: false,
        authorized: false,
      });

      await service.captureFromWebhook(CHARGE_ID);

      expect(fsm.transition).not.toHaveBeenCalled();
      expect(emitter.emit).not.toHaveBeenCalled();
    });

    it('payment ไม่พบ → log + return (ไม่ throw)', async () => {
      prisma.payment.findFirst.mockResolvedValue(null);
      await expect(
        service.captureFromWebhook('chrg_unknown'),
      ).resolves.toBeUndefined();
      expect(fsm.transition).not.toHaveBeenCalled();
    });

    it('chargeId ว่าง → skip ทันที', async () => {
      await service.captureFromWebhook('');
      expect(prisma.payment.findFirst).not.toHaveBeenCalled();
    });
  });

  // ─── paymentByBooking (polling) ────────────────────────────────────────

  describe('paymentByBooking', () => {
    it('คืน payment พร้อม qrCodeUrl สำหรับ patient', async () => {
      prisma.payment.findUnique.mockResolvedValue(fakePromptPayPayment());

      const result = await service.paymentByBooking(
        BOOKING_ID,
        asUser(PATIENT_ID, ROLE_ID.PATIENT),
      );

      expect(result?.qrCodeUrl).toBe(QR_URL);
      expect(result?.paymentStatus).toBe(PaymentStatus.pending);
    });

    it('non-party non-admin → ForbiddenException', async () => {
      prisma.payment.findUnique.mockResolvedValue(fakePromptPayPayment());
      await expect(
        service.paymentByBooking(BOOKING_ID, asUser('stranger', ROLE_ID.PATIENT)),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('polling fallback — pending+promptpay + Omise=paid → reconcile + คืน captured', async () => {
      const pendingPayment = fakePromptPayPayment();
      const capturedPayment = fakePromptPayPayment({ paymentStatus: 'captured' });
      // 1st findUnique: pending; 2nd (หลัง reconcile): captured
      prisma.payment.findUnique
        .mockResolvedValueOnce(pendingPayment)
        .mockResolvedValueOnce(capturedPayment);
      // captureFromWebhook ภายในใช้ findFirst — return pending (จะ proceed)
      prisma.payment.findFirst.mockResolvedValue(pendingPayment);
      omise.retrieveCharge.mockResolvedValue({
        id: CHARGE_ID,
        status: 'successful',
        amount: 120000,
        captured: true,
        paid: true,
        authorized: true,
      });

      const result = await service.paymentByBooking(
        BOOKING_ID,
        asUser(PATIENT_ID, ROLE_ID.PATIENT),
      );

      expect(omise.retrieveCharge).toHaveBeenCalled();
      expect(fsm.transition).toHaveBeenCalled();
      expect(result?.paymentStatus).toBe(PaymentStatus.captured);
    });

    it('polling ไม่ใช่ PromptPay (card) → ไม่เรียก retrieveCharge', async () => {
      prisma.payment.findUnique.mockResolvedValue(
        fakePromptPayPayment({ paymentMethod: 'credit_card', paymentStatus: 'held' }),
      );

      await service.paymentByBooking(BOOKING_ID, asUser(PATIENT_ID, ROLE_ID.PATIENT));

      expect(omise.retrieveCharge).not.toHaveBeenCalled();
    });

    it('payment ไม่พบ → คืน null', async () => {
      prisma.payment.findUnique.mockResolvedValue(null);
      const result = await service.paymentByBooking(
        BOOKING_ID,
        asUser(PATIENT_ID, ROLE_ID.PATIENT),
      );
      expect(result).toBeNull();
    });

    it('polling Omise ล้มเหลว → คืน payment เดิม (ไม่ throw)', async () => {
      prisma.payment.findUnique.mockResolvedValue(fakePromptPayPayment());
      omise.retrieveCharge.mockRejectedValue(new Error('Omise 503'));

      const result = await service.paymentByBooking(
        BOOKING_ID,
        asUser(PATIENT_ID, ROLE_ID.PATIENT),
      );

      expect(result?.paymentStatus).toBe(PaymentStatus.pending);
    });
  });
});
