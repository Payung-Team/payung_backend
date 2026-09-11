import { Test, TestingModule } from '@nestjs/testing';
import {
  ForbiddenException,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { BookingService } from './booking.service';
import { PrismaService } from '../common/prisma.service';
import { OmiseService } from '../payment/omise/omise.service';
import { PaymentStateMachine } from '../payment/payment-state-machine';
import { JobQrService } from '../monitoring/qr/job-qr.service';
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
        // PYG-434: createBooking สร้างใบ QR ด้วย — ไฟล์นี้ไม่ได้เทส createBooking
        // แต่ต้อง provide ให้ DI ผ่าน (มีเทสของตัวเองที่ job-qr.service.spec.ts)
        { provide: JobQrService, useValue: { createForBooking: jest.fn() } },
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

    // PYG-461/462: เทสเดิมตัวนี้สร้าง booking 'accepted' + payment 'held' ซึ่ง flow จริงไม่มีทางเกิด
    // (held เกิดใน tx เดียวกับ booking → 'confirmed' เท่านั้น — payment.service.ts createPayment)
    // จึงเขียวมาตลอดทั้งที่ของจริง void ไม่เคยทำงาน เพราะ cancellableStatuses ไม่มี 'confirmed'
    // → แก้ให้ตรง flow จริง: held คู่กับ confirmed เสมอ → cancelBooking ปฏิเสธ 422 ไม่แตะ Omise
    //   การ void จริงทดสอบที่ booking-settlement.service.spec.ts (เฟส 2) — ต่อ flow ใน 3a
    //   ไม่แก้ cancelBooking ในเฟสนี้ (ขอบเขต: ห้ามแตะ endpoint ยกเลิกของผู้ป่วย)
    it('flow จริง: confirmed + held → 422 (void ของ PYG-286 เข้าไม่ถึง) ไม่เรียก Omise/FSM/event', async () => {
      prisma.booking.findUnique.mockResolvedValue({
        ...fakeBookingWithPayment({
          id: PAYMENT_ID_LOCAL,
          paymentStatus: 'held',
          omiseChargeId: CHARGE_ID,
          amount: 1200,
        }),
        status: 'confirmed',
      });

      await expect(service.cancelBooking(BOOKING_ID, PATIENT_ID)).rejects.toBeInstanceOf(
        UnprocessableEntityException,
      );

      expect(omise.voidCharge).not.toHaveBeenCalled();
      expect(fsm.transition).not.toHaveBeenCalled();
      expect(tx.booking.update).not.toHaveBeenCalled();
      expect(emitter.emit).not.toHaveBeenCalled();
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

    // PYG-461/462: เทสเดิม 'payment status != held → defensive skip void (เช่น captured)' assert ว่า
    // booking 'accepted' + payment 'captured' ยกเลิกสำเร็จโดยไม่ void/ไม่คืนเงิน = ยืนยันพฤติกรรมที่
    // ผู้ป่วยเสียเงินฟรี → ลบทิ้ง แล้วแทนด้วย 2 ตัวข้างล่าง:
    //   (1) flow ปกติ: PromptPay captured → booking confirmed ใน tx เดียวกัน → cancelBooking ปฏิเสธ 422
    //   (2) บั๊กจริงที่ยังเปิดอยู่ (ไม่แก้ในเฟสนี้ — endpoint ยกเลิกเป็นขอบเขต 3a): staging มี
    //       booking 'accepted' + payment 'captured' จริง 4 แถว (dry-run 2026-09-11) → ยกเลิกได้โดยไม่คืนเงิน
    //       it.failing = ต้อง "fail" ตราบที่บั๊กยังอยู่ พอ 3a แก้แล้ว jest จะแดง บอกให้เปลี่ยนเป็น it ปกติ
    it('flow จริง: confirmed + captured (PromptPay) → 422 ยกเลิกไม่ได้ ไม่เปลี่ยนสถานะ', async () => {
      prisma.booking.findUnique.mockResolvedValue({
        ...fakeBookingWithPayment({
          id: PAYMENT_ID_LOCAL,
          paymentStatus: 'captured',
          omiseChargeId: CHARGE_ID,
          amount: 1200,
        }),
        status: 'confirmed',
      });

      await expect(service.cancelBooking(BOOKING_ID, PATIENT_ID)).rejects.toBeInstanceOf(
        UnprocessableEntityException,
      );
      expect(tx.booking.update).not.toHaveBeenCalled();
      expect(omise.voidCharge).not.toHaveBeenCalled();
      expect(fsm.transition).not.toHaveBeenCalled();
    });

    it.failing('บั๊กเปิดอยู่ (3a): accepted + captured → ต้องไม่ยกเลิกได้โดยไม่คืนเงิน', async () => {
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

      await expect(service.cancelBooking(BOOKING_ID, PATIENT_ID)).rejects.toBeInstanceOf(
        UnprocessableEntityException,
      );
    });

    // PYG-461/462: ลบเทส 'Omise void fail → ServiceUnavailableException' — ใช้ state 'accepted' + 'held'
    // ที่เกิดไม่ได้เหมือนกัน · พฤติกรรม "Omise fail → booking ไม่เปลี่ยน" ย้ายไปคุมที่
    // booking-settlement.service.spec.ts (describe 'Omise fail → booking ต้องไม่เปลี่ยนสถานะ')
  });
});
