import { Test, TestingModule } from '@nestjs/testing';
import {
  ForbiddenException,
  NotFoundException,
  ServiceUnavailableException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { BookingService } from './booking.service';
import { PrismaService } from '../common/prisma.service';
import { OmiseService } from '../payment/omise/omise.service';
import { PaymentStateMachine } from '../payment/payment-state-machine';
import { PaymentStatus } from '../payment/entities/payment-status.enum';
import { BOOKING_EVENTS } from '../notification/events/booking-event';
import { BookingStatusEnum } from './dto/booking-summary.types';

// ── Helpers ────────────────────────────────────────────────────────────────

const PATIENT_ID   = 'user-111';
const BOOKING_ID   = 'booking-aaa';
const CAREGIVER_ID = 'cg-222';

function fakeBooking(overrides: Record<string, unknown> = {}) {
  return {
    id:              BOOKING_ID,
    patientId:       PATIENT_ID,
    caregiverId:     CAREGIVER_ID,
    status:          'accepted',
    serviceType:     'general_care',
    timeSlot:        'morning',
    locationAddress: '123 Main St',
    bookingDate:     new Date('2026-07-01'),
    estimatedCost:   { toNumber: () => 500 },
    confirmedAt:     null,
    createdAt:       new Date('2026-06-01T08:00:00Z'),
    caregiver: {
      id:         CAREGIVER_ID,
      fullName:   'สมชาย ใจดี',
      hourlyRate: 350,
      user:       { avatarUrl: null },
    },
    careRecipient: null,
    ...overrides,
  };
}

// ── Setup ──────────────────────────────────────────────────────────────────

describe('BookingService', () => {
  let service: BookingService;
  let prisma: {
    booking: {
      findUnique: jest.Mock;
      update:     jest.Mock;
      findMany:   jest.Mock;
      count:      jest.Mock;
    };
    $transaction: jest.Mock;
  };
  // PYG-286: shared mocks for cancelBooking auto-void
  let tx: { booking: { update: jest.Mock } };
  let omise: { voidCharge: jest.Mock };
  let fsm: { transition: jest.Mock };
  let emitter: { emit: jest.Mock };

  beforeEach(async () => {
    tx = { booking: { update: jest.fn() } };
    prisma = {
      booking: {
        findUnique: jest.fn(),
        update:     jest.fn(),
        findMany:   jest.fn(),
        count:      jest.fn(),
      },
      $transaction: jest.fn((cb: (t: typeof tx) => unknown) => cb(tx)),
    };
    omise = { voidCharge: jest.fn() };
    fsm = { transition: jest.fn() };
    emitter = { emit: jest.fn() };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        BookingService,
        { provide: PrismaService, useValue: prisma },
        // PYG-292: BookingService ยิง booking event — mock EventEmitter2 ใน test
        { provide: EventEmitter2, useValue: emitter },
        // PYG-286: cancelBooking auto-void deps
        { provide: OmiseService, useValue: omise },
        { provide: PaymentStateMachine, useValue: fsm },
      ],
    }).compile();

    service = module.get<BookingService>(BookingService);
  });

  // ── confirmBooking ──────────────────────────────────────────────────────

  describe('confirmBooking', () => {
    it('returns BookingSummary with status=confirmed on happy path', async () => {
      prisma.booking.findUnique.mockResolvedValue(fakeBooking());
      const confirmed = fakeBooking({ status: 'confirmed', confirmedAt: new Date() });
      prisma.booking.update.mockResolvedValue(confirmed);

      const result = await service.confirmBooking(BOOKING_ID, PATIENT_ID);

      expect(prisma.booking.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: BOOKING_ID },
          data: expect.objectContaining({ status: 'confirmed' }),
        }),
      );
      expect(result.id).toBe(BOOKING_ID);
      expect(result.status).toBe('confirmed');
      expect(result.confirmedAt).toBeDefined();
    });

    it('throws NotFoundException when booking does not exist', async () => {
      prisma.booking.findUnique.mockResolvedValue(null);

      await expect(service.confirmBooking(BOOKING_ID, PATIENT_ID))
        .rejects.toThrow(NotFoundException);
    });

    it('throws ForbiddenException when patient does not own the booking', async () => {
      prisma.booking.findUnique.mockResolvedValue(fakeBooking({ patientId: 'other-user' }));

      await expect(service.confirmBooking(BOOKING_ID, PATIENT_ID))
        .rejects.toThrow(ForbiddenException);
    });

    it('throws UnprocessableEntityException when status is not accepted', async () => {
      prisma.booking.findUnique.mockResolvedValue(fakeBooking({ status: 'pending' }));

      await expect(service.confirmBooking(BOOKING_ID, PATIENT_ID))
        .rejects.toThrow(UnprocessableEntityException);
    });

    it('maps estimatedCost from Decimal to number', async () => {
      prisma.booking.findUnique.mockResolvedValue(fakeBooking());
      prisma.booking.update.mockResolvedValue(
        fakeBooking({ status: 'confirmed', estimatedCost: { toNumber: () => 350.5 } }),
      );

      const result = await service.confirmBooking(BOOKING_ID, PATIENT_ID);

      expect(result.estimatedCost).toBe(350.5);
    });

    it('maps careRecipientName when care_recipient exists', async () => {
      prisma.booking.findUnique.mockResolvedValue(
        fakeBooking({ careRecipient: { name: 'คุณย่า' } }),
      );
      prisma.booking.update.mockResolvedValue(
        fakeBooking({ status: 'confirmed', careRecipient: { name: 'คุณย่า' } }),
      );

      const result = await service.confirmBooking(BOOKING_ID, PATIENT_ID);

      expect(result.careRecipientName).toBe('คุณย่า');
    });
  });

  // ── myBookingHistory ────────────────────────────────────────────────────

  describe('myBookingHistory', () => {
    it('queries all statuses when no status filter set', async () => {
      prisma.booking.findMany.mockResolvedValue([]);
      prisma.booking.count.mockResolvedValue(0);

      await service.myBookingHistory(PATIENT_ID, {});

      const call = prisma.booking.findMany.mock.calls[0][0];
      expect(call.where).toEqual({ patientId: PATIENT_ID });
    });

    it('filters by status when status is set', async () => {
      prisma.booking.findMany.mockResolvedValue([]);
      prisma.booking.count.mockResolvedValue(0);

      await service.myBookingHistory(PATIENT_ID, { status: BookingStatusEnum.COMPLETED });

      const call = prisma.booking.findMany.mock.calls[0][0];
      expect(call.where).toEqual({ patientId: PATIENT_ID, status: 'completed' });
    });

    it('orders by createdAt desc', async () => {
      prisma.booking.findMany.mockResolvedValue([]);
      prisma.booking.count.mockResolvedValue(0);

      await service.myBookingHistory(PATIENT_ID, {});

      expect(prisma.booking.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ orderBy: { createdAt: 'desc' } }),
      );
    });

    it('formats bookingDate as YYYY-MM-DD string', async () => {
      prisma.booking.findMany.mockResolvedValue([fakeBooking()]);
      prisma.booking.count.mockResolvedValue(1);

      const result = await service.myBookingHistory(PATIENT_ID, {});

      expect(result.data[0].bookingDate).toBe('2026-07-01');
    });

    it('returns null confirmedAt as undefined', async () => {
      prisma.booking.findMany.mockResolvedValue([fakeBooking({ confirmedAt: null })]);
      prisma.booking.count.mockResolvedValue(1);

      const result = await service.myBookingHistory(PATIENT_ID, {});

      expect(result.data[0].confirmedAt).toBeUndefined();
    });

    it('computes correct pagination for page 2', async () => {
      const rows = Array.from({ length: 3 }, (_, i) => fakeBooking({ id: `b-${i}` }));
      prisma.booking.findMany.mockResolvedValue(rows);
      prisma.booking.count.mockResolvedValue(13);

      const result = await service.myBookingHistory(PATIENT_ID, { page: 2, limit: 3 });

      expect(result.pagination).toMatchObject({ page: 2, limit: 3, total: 13, totalPages: 5 });
      expect(prisma.booking.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ skip: 3, take: 3 }),
      );
    });
  });

  // ── cancelBooking + auto-void (PYG-286) ────────────────────────────────────

  describe('cancelBooking auto-void (PYG-286)', () => {
    const CHARGE_ID = 'chrg_test_1';
    const PAYMENT_ID_LOCAL = 'pay-cancel-1';

    /** booking ที่มี caregiver.userId + payment ตามรูปทรงที่ cancelBooking select */
    function fakeBookingWithPayment(payment: Record<string, unknown> | null) {
      return {
        ...fakeBooking({ status: 'accepted' }),
        caregiver: {
          id: CAREGIVER_ID,
          userId: 'cg-user-1',
          fullName: 'สมชาย ใจดี',
          hourlyRate: 350,
          user: { avatarUrl: null },
        },
        payment,
      };
    }

    it('held payment + omiseChargeId → void + FSM voided + emit PAYMENT_VOIDED + CANCELLED', async () => {
      prisma.booking.findUnique.mockResolvedValue(
        fakeBookingWithPayment({
          id: PAYMENT_ID_LOCAL,
          paymentStatus: 'held',
          omiseChargeId: CHARGE_ID,
          amount: 1200,
        }),
      );
      tx.booking.update.mockResolvedValue({
        ...fakeBooking({ status: 'cancelled' }),
        caregiver: {
          id: CAREGIVER_ID,
          userId: 'cg-user-1',
          fullName: 'สมชาย ใจดี',
          hourlyRate: 350,
          user: { avatarUrl: null },
        },
      });
      omise.voidCharge.mockResolvedValue({ id: CHARGE_ID, status: 'reversed' });
      fsm.transition.mockResolvedValue({});

      await service.cancelBooking(BOOKING_ID, PATIENT_ID);

      // Omise void เรียกด้วย charge id ของ payment
      expect(omise.voidCharge).toHaveBeenCalledWith(CHARGE_ID);

      // FSM held → voided ใน tx เดียวกับ booking.update
      expect(fsm.transition).toHaveBeenCalledWith(
        PAYMENT_ID_LOCAL,
        PaymentStatus.voided,
        expect.objectContaining({ changedBy: PATIENT_ID }),
        tx,
      );

      // emit 2 events: CANCELLED (→ caregiver) + PAYMENT_VOIDED (→ patient) — ไม่ซ้ำ
      const events = emitter.emit.mock.calls.map((c) => c[0]);
      expect(events).toContain(BOOKING_EVENTS.CANCELLED);
      expect(events).toContain(BOOKING_EVENTS.PAYMENT_VOIDED);
      expect(emitter.emit).toHaveBeenCalledTimes(2);
    });

    it('ไม่มี payment → ไม่เรียก Omise / ไม่ FSM / emit แค่ CANCELLED', async () => {
      prisma.booking.findUnique.mockResolvedValue(fakeBookingWithPayment(null));
      tx.booking.update.mockResolvedValue({
        ...fakeBooking({ status: 'cancelled' }),
        caregiver: {
          id: CAREGIVER_ID,
          userId: 'cg-user-1',
          fullName: 'สมชาย ใจดี',
          hourlyRate: 350,
          user: { avatarUrl: null },
        },
      });

      await service.cancelBooking(BOOKING_ID, PATIENT_ID);

      expect(omise.voidCharge).not.toHaveBeenCalled();
      expect(fsm.transition).not.toHaveBeenCalled();
      expect(emitter.emit).toHaveBeenCalledTimes(1);
      expect(emitter.emit.mock.calls[0][0]).toBe(BOOKING_EVENTS.CANCELLED);
    });

    it('payment status != held → defensive skip void (เช่น captured)', async () => {
      prisma.booking.findUnique.mockResolvedValue(
        fakeBookingWithPayment({
          id: PAYMENT_ID_LOCAL,
          paymentStatus: 'captured',
          omiseChargeId: CHARGE_ID,
          amount: 1200,
        }),
      );
      tx.booking.update.mockResolvedValue({
        ...fakeBooking({ status: 'cancelled' }),
        caregiver: {
          id: CAREGIVER_ID,
          userId: 'cg-user-1',
          fullName: 'สมชาย ใจดี',
          hourlyRate: 350,
          user: { avatarUrl: null },
        },
      });

      await service.cancelBooking(BOOKING_ID, PATIENT_ID);

      expect(omise.voidCharge).not.toHaveBeenCalled();
      expect(fsm.transition).not.toHaveBeenCalled();
    });

    it('Omise void fail → ServiceUnavailableException + ไม่เปลี่ยน status booking', async () => {
      prisma.booking.findUnique.mockResolvedValue(
        fakeBookingWithPayment({
          id: PAYMENT_ID_LOCAL,
          paymentStatus: 'held',
          omiseChargeId: CHARGE_ID,
          amount: 1200,
        }),
      );
      omise.voidCharge.mockRejectedValue(new Error('Omise 503'));

      await expect(service.cancelBooking(BOOKING_ID, PATIENT_ID)).rejects.toBeInstanceOf(
        ServiceUnavailableException,
      );

      // tx callback ต้องไม่ถูกเรียกถ้า Omise พัง
      expect(tx.booking.update).not.toHaveBeenCalled();
      expect(fsm.transition).not.toHaveBeenCalled();
      expect(emitter.emit).not.toHaveBeenCalled();
    });
  });
});
