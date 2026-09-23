import { Test, TestingModule } from '@nestjs/testing';
import {
  ForbiddenException,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { BookingService } from './booking.service';
import { PrismaService } from '../common/prisma.service';
import { JobQrService } from '../monitoring/qr/job-qr.service';
import { ConsentService } from '../consent/consent.service';
import { BookingSettlementService } from '../payment/settlement/booking-settlement.service';
import {
  SettlementBlockedError,
  SettlementReason,
} from '../payment/settlement/booking-settlement.types';
import { BOOKING_EVENTS } from '../notification/events/booking-event';
import { BookingStatusEnum } from './dto/booking-summary.types';

// ── Helpers ────────────────────────────────────────────────────────────────

const PATIENT_ID   = 'user-111';
const BOOKING_ID   = 'booking-aaa';
const CAREGIVER_ID = 'cg-222';
const GROUP_ID     = 'group-333';

function fakeBooking(overrides: Record<string, unknown> = {}) {
  return {
    id:              BOOKING_ID,
    patientId:       PATIENT_ID,
    caregiverId:     CAREGIVER_ID,
    familyGroupId:   null,
    bookedBy:        null,
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
      findUnique:        jest.Mock;
      findUniqueOrThrow: jest.Mock;
      update:            jest.Mock;
      findMany:          jest.Mock;
      count:             jest.Mock;
    };
    $transaction: jest.Mock;
  };
  // PYG-286: shared mocks for cancelBooking auto-void
  let tx: { booking: { update: jest.Mock } };
  // PYG-461 เฟส 3a: เงินตอนยกเลิกอยู่ที่ settle() — ไฟล์นี้เทสแค่ "เรียกถูกไหม + แจ้งเตือนถูกไหม"
  // พฤติกรรมของเงินเองมีเทสของตัวเองที่ booking-settlement.service.spec.ts (1,235 บรรทัด)
  let settlement: { settle: jest.Mock };
  let emitter: { emit: jest.Mock };

  beforeEach(async () => {
    tx = { booking: { update: jest.fn() } };
    prisma = {
      booking: {
        findUnique:        jest.fn(),
        findUniqueOrThrow: jest.fn(),
        update:            jest.fn(),
        findMany:          jest.fn(),
        count:             jest.fn(),
      },
      $transaction: jest.fn((cb: (t: typeof tx) => unknown) => cb(tx)),
    };
    settlement = {
      settle: jest.fn().mockResolvedValue({
        bookingId: BOOKING_ID,
        reason: SettlementReason.PATIENT_CANCEL,
        alreadySettled: false,
        bookingStatusBefore: 'accepted',
        bookingStatusAfter: 'cancelled',
        moneyAction: 'none',
        paymentStatusBefore: null,
        paymentStatusAfter: null,
        refundAmount: null,
        refundPercentage: null,
      }),
    };
    emitter = { emit: jest.fn() };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        BookingService,
        { provide: PrismaService, useValue: prisma },
        // PYG-292: BookingService ยิง booking event — mock EventEmitter2 ใน test
        { provide: EventEmitter2, useValue: emitter },
        // PYG-461 เฟส 3a: cancelBooking เรียก settle() แทนการแตะ Omise/FSM เอง
        { provide: BookingSettlementService, useValue: settlement },
        // PYG-434: createBooking สร้างใบ QR ด้วย — ไฟล์นี้ไม่ได้เทส createBooking
        // แต่ต้อง provide ให้ DI ผ่าน (มีเทสของตัวเองที่ job-qr.service.spec.ts)
        { provide: JobQrService, useValue: { createForBooking: jest.fn() } },
        // PYG-540: ด่านความยินยอมก่อนจอง — ค่าเริ่มต้น = ไม่มีใครถอน (เทสด่านอยู่ที่ booking-consent-gate.service.spec.ts)
        {
          provide: ConsentService,
          useValue: {
            findWithdrawnType: jest.fn().mockResolvedValue(null),
            withdrawnUserIds: jest.fn().mockResolvedValue(new Set()),
          },
        },
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
      expect(call.where).toEqual({ patientId: PATIENT_ID, familyGroupId: null });
    });

    it('ไม่รวมใบจองแทนในกลุ่มครอบครัว — ทั้งรายการและตัวนับ', async () => {
      prisma.booking.findMany.mockResolvedValue([]);
      prisma.booking.count.mockResolvedValue(0);

      await service.myBookingHistory(PATIENT_ID, {});

      // ใบจองแทนมี patientId = คนกดจอง ถ้าไม่กรอง familyGroupId จะปนมาใน "นัดหมายของฉัน"
      expect(prisma.booking.findMany.mock.calls[0][0].where).toMatchObject({ familyGroupId: null });
      expect(prisma.booking.count.mock.calls[0][0].where).toMatchObject({ familyGroupId: null });
    });

    it('filters by status when status is set', async () => {
      prisma.booking.findMany.mockResolvedValue([]);
      prisma.booking.count.mockResolvedValue(0);

      await service.myBookingHistory(PATIENT_ID, { status: BookingStatusEnum.COMPLETED });

      const call = prisma.booking.findMany.mock.calls[0][0];
      expect(call.where).toEqual({ patientId: PATIENT_ID, familyGroupId: null, status: 'completed' });
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

  describe('groupBookingById', () => {
    it('returns the same booking detail to another member as read-only', async () => {
      prisma.booking.findUnique.mockResolvedValue(fakeBooking({
        familyGroupId: GROUP_ID,
        bookedBy: PATIENT_ID,
      }));

      const result = await service.groupBookingById(BOOKING_ID, GROUP_ID, 'family-member');

      expect(result.id).toBe(BOOKING_ID);
      expect(result.bookedByMe).toBe(false);
    });

    it('marks the member who created the booking as able to manage it', async () => {
      prisma.booking.findUnique.mockResolvedValue(fakeBooking({
        familyGroupId: GROUP_ID,
        bookedBy: PATIENT_ID,
      }));

      const result = await service.groupBookingById(BOOKING_ID, GROUP_ID, PATIENT_ID);

      expect(result.bookedByMe).toBe(true);
    });

    it('does not expose a booking through a different family group', async () => {
      prisma.booking.findUnique.mockResolvedValue(fakeBooking({
        familyGroupId: 'another-group',
        bookedBy: PATIENT_ID,
      }));

      await expect(service.groupBookingById(BOOKING_ID, GROUP_ID, PATIENT_ID))
        .rejects.toThrow(NotFoundException);
    });
  });


  // ── cancelBooking → settle() (PYG-461 เฟส 3a) ──────────────────────────────

  /**
   * ขอบเขตของ describe นี้: cancelBooking เหลือหน้าที่ "สิทธิ์ + แจ้งเตือนระดับ booking"
   * เงินทุกเส้นทาง (held → void, captured → refund, PromptPay pending, payout ที่จ่ายแล้ว)
   * มีเทสของตัวเองอยู่แล้วที่ booking-settlement.service.spec.ts — ที่นี่ไม่ทำซ้ำ
   * ที่นี่คุมแค่ 4 อย่างที่ settle() ทำแทนไม่ได้:
   *   ① เจ้าของ booking เท่านั้นที่ยกเลิกได้ (settle ไม่รู้จักเจ้าของ — cron ก็เรียกได้)
   *   ② เรียก settle ด้วย reason/actor ที่ถูก
   *   ③ settle บล็อก (422) → ต้องไม่แจ้งเตือน ไม่คืน summary ว่าสำเร็จ
   *   ④ แจ้งเตือน CANCELLED ยิงครั้งเดียว และไม่ยิงซ้ำตอนเรียกซ้ำ
   */
  describe('cancelBooking → settle (PYG-461 เฟส 3a)', () => {
    /** แถวที่ findUniqueOrThrow คืนหลัง settle — สถานะเปลี่ยนเป็น cancelled แล้ว */
    function cancelledRow() {
      return {
        ...fakeBooking({ status: 'cancelled' }),
        caregiver: {
          id:         CAREGIVER_ID,
          userId:     'cg-user-1',
          fullName:   'สมชาย ใจดี',
          hourlyRate: 350,
          user:       { avatarUrl: null },
        },
        careRecipient: null,
      };
    }

    beforeEach(() => {
      prisma.booking.findUnique.mockResolvedValue({
        id: BOOKING_ID,
        patientId: PATIENT_ID,
      });
      prisma.booking.findUniqueOrThrow.mockResolvedValue(cancelledRow());
    });

    // ── ① สิทธิ์ — ด่านที่ต้องอยู่ที่นี่ต่อ ───────────────────────────────
    it('ไม่พบ booking → 404 และไม่เรียก settle', async () => {
      prisma.booking.findUnique.mockResolvedValue(null);

      await expect(service.cancelBooking(BOOKING_ID, PATIENT_ID)).rejects.toBeInstanceOf(
        NotFoundException,
      );
      expect(settlement.settle).not.toHaveBeenCalled();
    });

    it('★ booking ของคนอื่น → 403 และไม่เรียก settle (settle ไม่ตรวจเจ้าของให้)', async () => {
      prisma.booking.findUnique.mockResolvedValue({
        id: BOOKING_ID,
        patientId: 'user-someone-else',
      });

      await expect(service.cancelBooking(BOOKING_ID, PATIENT_ID)).rejects.toBeInstanceOf(
        ForbiddenException,
      );
      // ★ ถ้าด่านนี้หลุด คนอื่นจะสั่ง refund/void เงินของคนอื่นได้ผ่าน endpoint นี้
      expect(settlement.settle).not.toHaveBeenCalled();
      expect(emitter.emit).not.toHaveBeenCalled();
    });

    // ── ② เรียก settle ถูกตัว ─────────────────────────────────────────────
    it('เรียก settle ด้วย reason patient_cancel และ actor = ผู้ป่วยที่กด', async () => {
      await service.cancelBooking(BOOKING_ID, PATIENT_ID);

      expect(settlement.settle).toHaveBeenCalledTimes(1);
      expect(settlement.settle).toHaveBeenCalledWith(
        BOOKING_ID,
        SettlementReason.PATIENT_CANCEL,
        { id: PATIENT_ID, role: 'patient' },
      );
    });

    it('★ ไม่แตะเงินเอง — ไม่มี $transaction / booking.update จาก cancelBooking อีกแล้ว', async () => {
      await service.cancelBooking(BOOKING_ID, PATIENT_ID);

      // ทั้ง booking.status และ payment ถูกเขียนใน tx ของ settle() ที่ถือ row lock
      // ถ้าที่นี่เขียนเองด้วย จะมีคนเขียน booking สองที่ และ lock order จะไม่ถูกคุมแล้ว
      expect(prisma.$transaction).not.toHaveBeenCalled();
      expect(prisma.booking.update).not.toHaveBeenCalled();
    });

    it('คืน summary จากแถวที่อ่านใหม่หลัง settle (status = cancelled ไม่ใช่ค่าก่อนยกเลิก)', async () => {
      const result = await service.cancelBooking(BOOKING_ID, PATIENT_ID);

      expect(prisma.booking.findUniqueOrThrow).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: BOOKING_ID } }),
      );
      expect(result.status).toBe('cancelled');
    });

    // ── ③ settle บล็อก → คำขอต้องล้ม ไม่ใช่เงียบ ──────────────────────────
    it('★ settle บล็อก (เช่นจ่ายเงินให้ผู้ดูแลไปแล้ว) → error เด้งออก ไม่แจ้งเตือน ไม่คืน summary', async () => {
      settlement.settle.mockRejectedValue(
        new SettlementBlockedError(
          'payout_already_released',
          'จ่ายเงินให้ผู้ดูแลไปแล้ว ยกเลิกเองไม่ได้',
        ),
      );

      await expect(service.cancelBooking(BOOKING_ID, PATIENT_ID)).rejects.toBeInstanceOf(
        UnprocessableEntityException,
      );

      // ★ ห้ามแจ้งผู้ดูแลว่า "ถูกยกเลิก" ทั้งที่ booking ยังไม่ถูกยกเลิกจริง
      expect(emitter.emit).not.toHaveBeenCalled();
      expect(prisma.booking.findUniqueOrThrow).not.toHaveBeenCalled();
    });

    it('settle ตอบ 422 ที่ลองใหม่ได้ (PromptPay ยังสแกนได้) → error เด้งออกพร้อม retryable', async () => {
      settlement.settle.mockRejectedValue(
        new SettlementBlockedError(
          'promptpay_still_scannable',
          'QR ยังสแกนจ่ายได้อยู่ กรุณาลองใหม่อีกครั้ง',
        ),
      );

      const err = await service
        .cancelBooking(BOOKING_ID, PATIENT_ID)
        .catch((e: SettlementBlockedError) => e);

      expect(err).toBeInstanceOf(SettlementBlockedError);
      expect((err as SettlementBlockedError).retryable).toBe(true);
    });

    // ── ④ แจ้งเตือน ───────────────────────────────────────────────────────
    it('ยกเลิกสำเร็จ → แจ้ง CANCELLED ครั้งเดียว (PAYMENT_VOIDED/REFUND_ISSUED เป็นของ settle)', async () => {
      await service.cancelBooking(BOOKING_ID, PATIENT_ID);

      expect(emitter.emit).toHaveBeenCalledTimes(1);
      expect(emitter.emit.mock.calls[0][0]).toBe(BOOKING_EVENTS.CANCELLED);
      const event = emitter.emit.mock.calls[0][1] as Record<string, unknown>;
      expect(event).toMatchObject({
        bookingId: BOOKING_ID,
        patientId: PATIENT_ID,
        caregiverId: 'cg-user-1',
      });
    });

    it('บัตร: settle คืน voided → ยังแจ้ง CANCELLED ตัวเดียว ไม่ยิง PAYMENT_VOIDED ซ้ำ', async () => {
      settlement.settle.mockResolvedValue({
        bookingId: BOOKING_ID,
        reason: SettlementReason.PATIENT_CANCEL,
        alreadySettled: false,
        bookingStatusBefore: 'confirmed',
        bookingStatusAfter: 'cancelled',
        moneyAction: 'voided',
        paymentStatusBefore: 'held',
        paymentStatusAfter: 'voided',
        refundAmount: null,
        refundPercentage: null,
      });

      await service.cancelBooking(BOOKING_ID, PATIENT_ID);

      const events = emitter.emit.mock.calls.map((c) => c[0]) as string[];
      expect(events).toEqual([BOOKING_EVENTS.CANCELLED]);
      expect(events).not.toContain(BOOKING_EVENTS.PAYMENT_VOIDED);
    });

    it('★ กดยกเลิกซ้ำ (alreadySettled) → ไม่แจ้งเตือนผู้ดูแลอีกรอบ แต่ยังคืน summary ปกติ', async () => {
      settlement.settle.mockResolvedValue({
        bookingId: BOOKING_ID,
        reason: SettlementReason.PATIENT_CANCEL,
        alreadySettled: true,
        bookingStatusBefore: 'cancelled',
        bookingStatusAfter: 'cancelled',
        moneyAction: 'none',
        paymentStatusBefore: 'voided',
        paymentStatusAfter: 'voided',
        refundAmount: null,
        refundPercentage: null,
      });

      const result = await service.cancelBooking(BOOKING_ID, PATIENT_ID);

      expect(emitter.emit).not.toHaveBeenCalled();
      expect(result.status).toBe('cancelled');
    });

    // ── บั๊กที่การ์ด PYG-461 เปิดไว้ — ตอนนี้ปิดแล้ว ──────────────────────
    /**
     * เฟส 2 ทิ้ง it.failing ไว้ว่า "accepted + captured ยกเลิกได้โดยไม่คืนเงิน"
     * เฟส 3a ปิดด้วยการยก matrix เงินทั้งก้อนไปไว้ใน settle() → เทสกลายเป็น it ปกติ
     *
     * ที่นี่ assert แค่ว่า "ทุกเส้นทางต้องผ่าน settle" ซึ่งเป็นสิ่งที่ทำให้บั๊กเกิดซ้ำไม่ได้
     * ตัวนโยบายคืนเงิน (คืนกี่ %) อยู่ในเทสของ settle
     */
    it('captured (PromptPay จ่ายจริงแล้ว) ก็ต้องผ่าน settle — ไม่มีเส้นทางยกเลิกที่ข้ามเรื่องเงิน', async () => {
      settlement.settle.mockResolvedValue({
        bookingId: BOOKING_ID,
        reason: SettlementReason.PATIENT_CANCEL,
        alreadySettled: false,
        bookingStatusBefore: 'confirmed',
        bookingStatusAfter: 'cancelled',
        moneyAction: 'refunded',
        paymentStatusBefore: 'captured',
        paymentStatusAfter: 'refunded',
        refundAmount: 1200,
        refundPercentage: 100,
      });

      await service.cancelBooking(BOOKING_ID, PATIENT_ID);

      expect(settlement.settle).toHaveBeenCalledWith(
        BOOKING_ID,
        SettlementReason.PATIENT_CANCEL,
        { id: PATIENT_ID, role: 'patient' },
      );
    });
  });
});
