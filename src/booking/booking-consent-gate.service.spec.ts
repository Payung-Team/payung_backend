/**
 * PYG-540 — ด่านความยินยอมใน BookingService
 *
 * สิ่งที่การ์ดบังคับ: "ถอนความยินยอมแล้ว มีผลจริงในระบบ"
 *   ① จองให้ตัวเอง (REST) — ถอนข้อมูลสุขภาพ / การเปิดเผยแก่ผู้ดูแล → จองใหม่ไม่ได้ (403 + code)
 *   ② จองแทนในกลุ่ม (GraphQL) — ตรวจ "เจ้าของข้อมูล" ไม่ใช่คนกดจอง และตรวจหลังเช็คสิทธิ์กลุ่ม
 *   ③ นัดหมายของกลุ่ม — คนที่ถอนข้อ family group ต้องไม่โผล่ให้สมาชิกคนอื่นเห็น
 *
 * แยกไฟล์จาก spec เดิม (แพตเทิร์นเดียวกับ create-booking-on-behalf.service.spec.ts)
 * เพื่อไม่ต้องแก้ setup ร่วมของเทสเก่า
 */
import { ForbiddenException } from '@nestjs/common';
import type { EventEmitter2 } from '@nestjs/event-emitter';
import type { GraphQLError } from 'graphql';
import { BookingService } from './booking.service';
import type { CreateBookingDto } from './dto/create-booking.dto';
import type { PrismaService } from '../common/prisma.service';
import type { BookingSettlementService } from '../payment/settlement/booking-settlement.service';
import type { JobQrService } from '../monitoring/qr/job-qr.service';
import type { ConsentService } from '../consent/consent.service';
import {
  BOOKING_BLOCKING_CONSENTS,
  CONSENT_TYPE,
  ON_BEHALF_BLOCKING_CONSENTS,
} from '../consent/consent.constants';
import { CONSENT_ERROR } from '../consent/consent.errors';
import { FG_ERROR } from '../family-group/family-group.errors';

const PATIENT_ID = 'user-patient-1';
const BOOKER_ID = 'user-booker-1';
const OWNER_ID = 'user-owner-2';
const GROUP_ID = '11111111-1111-4111-8111-111111111111';
const RECIPIENT_ID = '22222222-2222-4222-8222-222222222222';

/** input ขั้นต่ำ — เทสนี้หยุดก่อนถึง createBookingRecord หรือ spy แทนมันอยู่แล้ว */
const DTO: CreateBookingDto = {
  tasks: ['อาบน้ำ'],
  serviceLocations: ['บ้าน'],
  serviceType: 'elderly_care',
  timeSlot: 'morning',
  startTime: '09:00',
  durationHours: 4,
  locationAddress: '123 ถนนสุขุมวิท',
  bookingDate: '2026-10-01',
};

/** prisma ปลอม — มีเฉพาะตารางที่ด่านความยินยอมแตะ */
type PrismaMock = {
  careRecipient: {
    findUnique: jest.Mock;
    findFirst: jest.Mock;
    create: jest.Mock;
  };
  familyGroupMember: { findFirst: jest.Mock };
  booking: { findMany: jest.Mock };
};

/** เมธอด private ที่เทสนี้ spy แทน (ตัวสร้าง booking จริง + ตัวแปลงผลลัพธ์) */
type BookingInternals = {
  createBookingRecord: (...args: unknown[]) => Promise<unknown>;
  toRestSummary: (...args: unknown[]) => unknown;
  toSummary: (...args: unknown[]) => unknown;
};

/** รอให้ promise พังแล้วคืน error ที่ได้ (ไม่พัง = เทสล้ม) */
async function rejectionOf<E>(promise: Promise<unknown>): Promise<E> {
  try {
    await promise;
  } catch (e) {
    return e as E;
  }
  throw new Error('expected the call to reject');
}

describe('BookingService — ด่านความยินยอม (PYG-540)', () => {
  let prisma: PrismaMock;
  let consent: { findWithdrawnType: jest.Mock; withdrawnUserIds: jest.Mock };
  let service: BookingService;
  /** แทนที่ตัวสร้าง booking จริง — เทสนี้สนใจแค่ "ผ่านด่านไปถึงหรือไม่" */
  let createRecord: jest.SpyInstance;

  beforeEach(() => {
    prisma = {
      careRecipient: {
        findUnique: jest.fn(),
        findFirst: jest.fn(),
        create: jest.fn(),
      },
      familyGroupMember: { findFirst: jest.fn() },
      booking: { findMany: jest.fn().mockResolvedValue([]) },
    };
    consent = {
      findWithdrawnType: jest.fn().mockResolvedValue(null),
      withdrawnUserIds: jest.fn().mockResolvedValue(new Set()),
    };

    service = new BookingService(
      prisma as unknown as PrismaService,
      { emit: jest.fn() } as unknown as EventEmitter2,
      { settle: jest.fn() } as unknown as BookingSettlementService,
      { createForBooking: jest.fn() } as unknown as JobQrService,
      consent as unknown as ConsentService,
    );

    const internals = service as unknown as BookingInternals;
    createRecord = jest
      .spyOn(internals, 'createBookingRecord')
      .mockResolvedValue({ id: 'booking-1' });
    jest.spyOn(internals, 'toRestSummary').mockReturnValue({ id: 'booking-1' });
    jest.spyOn(internals, 'toSummary').mockReturnValue({ id: 'booking-1' });
  });

  // ── ① จองให้ตัวเอง (REST) ────────────────────────────────────────────────

  describe('createBooking (REST)', () => {
    it('ไม่มีใครถอน → จองต่อได้ตามปกติ', async () => {
      await service.createBooking(PATIENT_ID, DTO);

      expect(consent.findWithdrawnType).toHaveBeenCalledWith(
        PATIENT_ID,
        BOOKING_BLOCKING_CONSENTS,
      );
      expect(createRecord).toHaveBeenCalled();
    });

    it.each([
      CONSENT_TYPE.SENSITIVE_HEALTH_DATA,
      CONSENT_TYPE.DISCLOSE_TO_CAREGIVER,
    ])(
      '★ ถอน %s → 403 พร้อม code CONSENT_WITHDRAWN และไม่สร้าง booking',
      async (type) => {
        consent.findWithdrawnType.mockResolvedValue(type);

        const err = await rejectionOf<ForbiddenException>(
          service.createBooking(PATIENT_ID, DTO),
        );

        expect(err).toBeInstanceOf(ForbiddenException);
        // ★ body ต้องมี statusCode (REST ส่งกลับตรง ๆ) + code ให้ FE แยกจาก 403 แบบอื่น
        expect(err.getResponse()).toMatchObject({
          statusCode: 403,
          code: CONSENT_ERROR.WITHDRAWN,
          consentType: type,
        });
        expect(createRecord).not.toHaveBeenCalled();
      },
    );
  });

  // ── ② จองแทนในกลุ่ม — เส้นทางเดิม (careRecipientId) ─────────────────────────

  describe('createBookingOnBehalf — careRecipientId', () => {
    const input = { ...DTO, groupId: GROUP_ID, careRecipientId: RECIPIENT_ID };

    beforeEach(() => {
      prisma.careRecipient.findUnique.mockResolvedValue({
        id: RECIPIENT_ID,
        name: 'คุณยายสมศรี',
        familyGroupId: GROUP_ID,
        patientId: OWNER_ID,
        is_deleted: false,
      });
      // PYG-516: เจ้าของโปรไฟล์ต้องยังเป็นสมาชิก ACTIVE
      prisma.familyGroupMember.findFirst.mockResolvedValue({
        userId: OWNER_ID,
      });
    });

    it('★ ตรวจความยินยอมของ "เจ้าของโปรไฟล์" ไม่ใช่คนกดจอง', async () => {
      await service.createBookingOnBehalf(BOOKER_ID, input);

      expect(consent.findWithdrawnType).toHaveBeenCalledWith(
        OWNER_ID,
        ON_BEHALF_BLOCKING_CONSENTS,
      );
      expect(createRecord).toHaveBeenCalled();
    });

    it('★ เจ้าของถอนข้อ family group → CONSENT_WITHDRAWN และไม่บอกว่าถอนข้อไหน', async () => {
      consent.findWithdrawnType.mockResolvedValue(
        CONSENT_TYPE.DISCLOSE_TO_FAMILY_GROUP,
      );

      const err = await rejectionOf<GraphQLError>(
        service.createBookingOnBehalf(BOOKER_ID, input),
      );

      expect(err.extensions).toEqual({ code: CONSENT_ERROR.WITHDRAWN });
      expect(err.message).not.toContain('กลุ่มครอบครัว');
      expect(createRecord).not.toHaveBeenCalled();
    });

    it('โปรไฟล์ไม่อยู่ในกลุ่ม → RECIPIENT_NOT_IN_GROUP ก่อน และไม่อ่านความยินยอมเลย', async () => {
      prisma.careRecipient.findUnique.mockResolvedValue({
        id: RECIPIENT_ID,
        name: 'คุณยายสมศรี',
        familyGroupId: 'another-group',
        patientId: OWNER_ID,
        is_deleted: false,
      });

      await expect(
        service.createBookingOnBehalf(BOOKER_ID, input),
      ).rejects.toMatchObject({
        extensions: { code: FG_ERROR.RECIPIENT_NOT_IN_GROUP },
      });
      // ★ กันคนนอกกลุ่มใช้ error ของด่านนี้แอบดูว่าใครถอนความยินยอม
      expect(consent.findWithdrawnType).not.toHaveBeenCalled();
    });
  });

  // ── ② จองแทนในกลุ่ม — โปรไฟล์ที่บันทึกไว้ (memberUserId + careRecipientId) ─────

  describe('createBookingOnBehalf — memberUserId + careRecipientId', () => {
    const input = {
      ...DTO,
      groupId: GROUP_ID,
      memberUserId: OWNER_ID,
      careRecipientId: RECIPIENT_ID,
    };

    it('★ สมาชิกถอนข้อ family group → หยุดก่อนอ่านโปรไฟล์ (รวมโปรไฟล์ส่วนตัว)', async () => {
      prisma.familyGroupMember.findFirst.mockResolvedValue({
        userId: OWNER_ID,
      });
      consent.findWithdrawnType.mockResolvedValue(
        CONSENT_TYPE.DISCLOSE_TO_FAMILY_GROUP,
      );

      await expect(
        service.createBookingOnBehalf(BOOKER_ID, input),
      ).rejects.toMatchObject({
        extensions: { code: CONSENT_ERROR.WITHDRAWN },
      });

      expect(consent.findWithdrawnType).toHaveBeenCalledWith(
        OWNER_ID,
        ON_BEHALF_BLOCKING_CONSENTS,
      );
      expect(prisma.careRecipient.findFirst).not.toHaveBeenCalled();
      expect(createRecord).not.toHaveBeenCalled();
    });

    it('ไม่ใช่สมาชิกกลุ่ม → MEMBER_NOT_FOUND ก่อน และไม่อ่านความยินยอม', async () => {
      prisma.familyGroupMember.findFirst.mockResolvedValue(null);

      await expect(
        service.createBookingOnBehalf(BOOKER_ID, input),
      ).rejects.toMatchObject({
        extensions: { code: FG_ERROR.MEMBER_NOT_FOUND },
      });
      expect(consent.findWithdrawnType).not.toHaveBeenCalled();
    });
  });

  // ── ② จองแทนในกลุ่ม — โมเดลสมาชิก (memberUserId, PYG-500) ─────────────────

  describe('createBookingOnBehalf — memberUserId', () => {
    const input = { ...DTO, groupId: GROUP_ID, memberUserId: OWNER_ID };

    it('★ สมาชิกถอนข้อมูลสุขภาพ → หยุดก่อนหา/คัดลอก/สร้างโปรไฟล์ในกลุ่ม', async () => {
      prisma.familyGroupMember.findFirst.mockResolvedValue({
        userId: OWNER_ID,
      });
      consent.findWithdrawnType.mockResolvedValue(
        CONSENT_TYPE.SENSITIVE_HEALTH_DATA,
      );

      await expect(
        service.createBookingOnBehalf(BOOKER_ID, input),
      ).rejects.toMatchObject({
        extensions: { code: CONSENT_ERROR.WITHDRAWN },
      });

      expect(consent.findWithdrawnType).toHaveBeenCalledWith(
        OWNER_ID,
        ON_BEHALF_BLOCKING_CONSENTS,
      );
      // ขั้น ②/③ คัดลอกข้อมูลสุขภาพเข้ากลุ่ม = สิ่งที่เขาถอนไปแล้ว → ต้องไม่เกิด
      expect(prisma.careRecipient.findFirst).not.toHaveBeenCalled();
      expect(prisma.careRecipient.create).not.toHaveBeenCalled();
      expect(createRecord).not.toHaveBeenCalled();
    });

    it('ไม่ใช่สมาชิกกลุ่ม → MEMBER_NOT_FOUND ก่อน และไม่อ่านความยินยอม', async () => {
      prisma.familyGroupMember.findFirst.mockResolvedValue(null);

      await expect(
        service.createBookingOnBehalf(BOOKER_ID, input),
      ).rejects.toMatchObject({
        extensions: { code: FG_ERROR.MEMBER_NOT_FOUND },
      });
      expect(consent.findWithdrawnType).not.toHaveBeenCalled();
    });

    it('จองแทนตัวเองในกลุ่ม + ถอนข้อ family group → บอกข้อที่ถอนและทางออก', async () => {
      const self = { ...input, memberUserId: BOOKER_ID };
      prisma.familyGroupMember.findFirst.mockResolvedValue({
        userId: BOOKER_ID,
      });
      consent.findWithdrawnType.mockResolvedValue(
        CONSENT_TYPE.DISCLOSE_TO_FAMILY_GROUP,
      );

      const err = await rejectionOf<GraphQLError>(
        service.createBookingOnBehalf(BOOKER_ID, self),
      );

      expect(err.extensions).toEqual({
        code: CONSENT_ERROR.WITHDRAWN,
        consentType: CONSENT_TYPE.DISCLOSE_TO_FAMILY_GROUP,
      });
      // เจ้าตัวยังจองแบบปกติได้ — ข้อความต้องบอกทางออกนี้
      expect(err.message).toContain('จองให้ตัวเอง');
    });

    it('ไม่มีใครถอน → ไปต่อที่การหา/สร้างโปรไฟล์ตามเดิม', async () => {
      prisma.familyGroupMember.findFirst.mockResolvedValue({
        userId: OWNER_ID,
      });
      prisma.careRecipient.findFirst.mockResolvedValue({
        id: RECIPIENT_ID,
        name: 'คุณยายสมศรี',
      });

      await service.createBookingOnBehalf(BOOKER_ID, input);

      expect(createRecord).toHaveBeenCalledWith(
        BOOKER_ID,
        expect.objectContaining({ careRecipientId: RECIPIENT_ID }),
        expect.objectContaining({ familyGroupId: GROUP_ID }),
      );
    });
  });

  // ── ③ นัดหมายของกลุ่ม ────────────────────────────────────────────────────

  describe('groupBookings', () => {
    /** แถว booking ขั้นต่ำที่ groupBookings ต้องใช้ */
    function row(id: string, ownerId: string, bookedBy: string) {
      return {
        id,
        patientId: bookedBy,
        bookedBy,
        bookingDate: new Date('2026-10-01'),
        startTime: new Date('1970-01-01T09:00:00Z'),
        status: 'unmatched',
        serviceType: 'elderly_care',
        durationHours: 4,
        careRecipient: { name: 'ผู้รับบริการ', patientId: ownerId },
        caregiver: null,
        bookedByUser: { displayName: 'คนจอง' },
        estimatedCost: null,
        serviceLocations: [],
        payment: null,
        jobEvents: [],
      };
    }

    beforeEach(() => {
      prisma.booking.findMany.mockResolvedValue([
        row('b-owner-withdrawn', OWNER_ID, BOOKER_ID),
        row('b-other', 'user-other-3', BOOKER_ID),
      ]);
      consent.withdrawnUserIds.mockResolvedValue(new Set([OWNER_ID]));
    });

    it('อ่านความยินยอมของเจ้าของทุกใบใน query เดียว', async () => {
      await service.groupBookings(GROUP_ID, 'user-viewer-9');

      expect(consent.withdrawnUserIds).toHaveBeenCalledTimes(1);
      expect(consent.withdrawnUserIds).toHaveBeenCalledWith(
        [OWNER_ID, 'user-other-3'],
        CONSENT_TYPE.DISCLOSE_TO_FAMILY_GROUP,
      );
    });

    it('★ สมาชิกคนอื่นไม่เห็นนัดของคนที่ถอนข้อ family group', async () => {
      const result = await service.groupBookings(GROUP_ID, 'user-viewer-9');
      expect(result.map((b) => b.id)).toEqual(['b-other']);
    });

    it('เจ้าของข้อมูลเองยังเห็นนัดของตัวเอง', async () => {
      const result = await service.groupBookings(GROUP_ID, OWNER_ID);
      expect(result.map((b) => b.id)).toEqual(['b-owner-withdrawn', 'b-other']);
    });

    it('คนกดจอง (คู่สัญญา) ยังเห็นใบที่ตัวเองจอง', async () => {
      const result = await service.groupBookings(GROUP_ID, BOOKER_ID);
      expect(result.map((b) => b.id)).toEqual(['b-owner-withdrawn', 'b-other']);
    });
  });
});
