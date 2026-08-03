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
