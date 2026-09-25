/**
 * PYG-499 — ด่าน "ผู้สูงอายุที่ยังไม่ผ่าน Onboarding สร้าง Booking ไม่ได้"
 *
 * Done ของการ์ด: "test ครอบกรณียังไม่ onboard → error, onboard แล้ว → สร้างได้ตามเดิม"
 *   ① จองให้ตัวเอง (REST)  — 403 + code ONBOARDING_REQUIRED ใน body
 *   ② จองแทนในกลุ่ม (GraphQL) — extensions.code ONBOARDING_REQUIRED · ตรวจ "คนกดจอง"
 *   ③ role อื่น (ผู้ดูแล / แอดมิน) ไม่โดนด่านนี้
 *   ④ ลำดับกับด่านความยินยอม (PYG-540) — ไม่ทำให้พฤติกรรมเดิมเปลี่ยน
 *
 * แยกไฟล์ (แพตเทิร์นเดียวกับ booking-consent-gate.service.spec.ts) — spy แทน createBookingRecord
 * เพราะเทสนี้สนใจแค่ "ผ่านด่านไปถึงตัวสร้าง booking หรือไม่"
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
import { CONSENT_TYPE } from '../consent/consent.constants';
import { CONSENT_ERROR } from '../consent/consent.errors';
import { FG_ERROR } from '../family-group/family-group.errors';
import { ROLE_ID } from '../common/constants/roles.constant';
import {
  ONBOARDING_ERROR,
  ONBOARDING_GATE_SELECT,
  ONBOARDING_REQUIRED_MESSAGE,
  OnboardingRequiredError,
  isOnboardingRequired,
} from '../identity/auth/onboarding-gate';

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

/** บัญชีผู้สูงอายุที่ผ่าน Onboarding แล้ว (completeOnboarding เขียนชื่อ-นามสกุลให้) */
const ONBOARDED_ELDER = { role: ROLE_ID.PATIENT, firstName: 'สมศรี', lastName: 'ใจดี' };
/** บัญชีผู้สูงอายุที่ยังไม่เคยกรอก Onboarding (สมัครใหม่ / บัญชีเก่าก่อน PYG-497) */
const NEW_ELDER = { role: ROLE_ID.PATIENT, firstName: null, lastName: null };

/** prisma ปลอม — มีเฉพาะตารางที่เส้นทางสร้าง booking แตะก่อนถึง createBookingRecord */
type PrismaMock = {
  user: { findUnique: jest.Mock };
  careRecipient: { findUnique: jest.Mock; findFirst: jest.Mock };
  familyGroupMember: { findFirst: jest.Mock };
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

describe('BookingService — ด่าน Onboarding (PYG-499)', () => {
  let prisma: PrismaMock;
  let consent: { findWithdrawnType: jest.Mock };
  let service: BookingService;
  /** แทนที่ตัวสร้าง booking จริง — ถูกเรียก = ผ่านด่านแล้ว */
  let createRecord: jest.SpyInstance;

  beforeEach(() => {
    prisma = {
      // ค่าเริ่มต้น = ผ่าน Onboarding แล้ว · เทสที่สนใจเคสตรงข้ามจะ override เอง
      user: { findUnique: jest.fn().mockResolvedValue(ONBOARDED_ELDER) },
      careRecipient: { findUnique: jest.fn(), findFirst: jest.fn() },
      familyGroupMember: { findFirst: jest.fn() },
    };
    consent = { findWithdrawnType: jest.fn().mockResolvedValue(null) };

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

  // ── เกณฑ์ (pure function) ────────────────────────────────────────────────

  describe('isOnboardingRequired', () => {
    it('ผู้สูงอายุที่มีชื่อ-นามสกุลครบ → ไม่ต้อง onboard', () => {
      expect(isOnboardingRequired(ONBOARDED_ELDER)).toBe(false);
    });

    it.each([
      ['ไม่มีทั้งคู่', null, null],
      ['ไม่มีนามสกุล', 'สมศรี', null],
      ['ไม่มีชื่อ', null, 'ใจดี'],
      ['สตริงว่าง', '', ''],
      // ★ ' ' ไม่ใช่ชื่อ — กันทางเขียนอื่นในอนาคตที่ไม่ trim ก่อนบันทึก
      ['มีแต่ช่องว่าง', '   ', '  '],
    ])('ผู้สูงอายุ %s → ต้อง onboard', (_label, firstName, lastName) => {
      expect(
        isOnboardingRequired({ role: ROLE_ID.PATIENT, firstName, lastName }),
      ).toBe(true);
    });

    it.each([
      ['ผู้ดูแล', ROLE_ID.CAREGIVER],
      ['แอดมิน', ROLE_ID.ADMIN],
    ])('★ %s ไม่มีชื่อ-นามสกุล → ไม่โดนด่าน (ไม่มีหน้า Onboarding ให้กรอก)', (_label, role) => {
      expect(isOnboardingRequired({ role, firstName: null, lastName: null })).toBe(false);
    });

    it('ไม่พบบัญชี → ไม่ใช่หน้าที่ของด่านนี้ (auth guard ตรวจไปแล้ว)', () => {
      expect(isOnboardingRequired(null)).toBe(false);
    });
  });

  // ── ① จองให้ตัวเอง (REST) ────────────────────────────────────────────────

  describe('createBooking (REST)', () => {
    it('onboard แล้ว → สร้าง booking ได้ตามเดิม', async () => {
      await service.createBooking(PATIENT_ID, DTO);

      // อ่านแค่คอลัมน์ที่ด่านต้องใช้ ของ "ผู้เรียก" คนนี้
      expect(prisma.user.findUnique).toHaveBeenCalledWith({
        where: { id: PATIENT_ID },
        select: ONBOARDING_GATE_SELECT,
      });
      expect(createRecord).toHaveBeenCalledWith(PATIENT_ID, DTO);
    });

    it('★ ยังไม่ onboard → 403 + code ONBOARDING_REQUIRED และไม่สร้าง booking', async () => {
      prisma.user.findUnique.mockResolvedValue(NEW_ELDER);

      const err = await rejectionOf<ForbiddenException>(
        service.createBooking(PATIENT_ID, DTO),
      );

      expect(err).toBeInstanceOf(ForbiddenException);
      // ★ body ต้องมี statusCode (REST ส่งกลับตรง ๆ) + code ที่ FE รออยู่
      //   (payung_frontend/src/lib/bookingSubmitError.ts → isOnboardingRequiredError)
      expect(err.getResponse()).toEqual({
        statusCode: 403,
        error: 'Forbidden',
        code: ONBOARDING_ERROR.REQUIRED,
        message: ONBOARDING_REQUIRED_MESSAGE,
      });
      expect(createRecord).not.toHaveBeenCalled();
    });

    it('ยังไม่ onboard + ถอนความยินยอมด้วย → ONBOARDING_REQUIRED ก่อน (หน้า Onboarding ขอความยินยอมให้ด้วย)', async () => {
      prisma.user.findUnique.mockResolvedValue(NEW_ELDER);
      consent.findWithdrawnType.mockResolvedValue(CONSENT_TYPE.SENSITIVE_HEALTH_DATA);

      const err = await rejectionOf<ForbiddenException>(
        service.createBooking(PATIENT_ID, DTO),
      );

      expect(err.getResponse()).toMatchObject({ code: ONBOARDING_ERROR.REQUIRED });
      expect(consent.findWithdrawnType).not.toHaveBeenCalled();
    });

    it('onboard แล้วแต่ถอนความยินยอม → ยังได้ CONSENT_WITHDRAWN เหมือนเดิม (PYG-540 ไม่เปลี่ยน)', async () => {
      consent.findWithdrawnType.mockResolvedValue(CONSENT_TYPE.SENSITIVE_HEALTH_DATA);

      const err = await rejectionOf<ForbiddenException>(
        service.createBooking(PATIENT_ID, DTO),
      );

      expect(err.getResponse()).toMatchObject({ code: CONSENT_ERROR.WITHDRAWN });
      expect(createRecord).not.toHaveBeenCalled();
    });
  });

  // ── ② จองแทนในกลุ่ม (GraphQL) ───────────────────────────────────────────

  describe('createBookingOnBehalf (GraphQL)', () => {
    // ทั้งสามรูปแบบ input ที่ mutation รับ — ด่านต้องครอบทุกแบบ
    const INPUTS = [
      ['careRecipientId (เส้นทางเดิม PYG-424)', { careRecipientId: RECIPIENT_ID }],
      ['memberUserId (โมเดลสมาชิก PYG-500)', { memberUserId: OWNER_ID }],
      [
        'memberUserId + careRecipientId (โปรไฟล์ที่บันทึกไว้)',
        { memberUserId: OWNER_ID, careRecipientId: RECIPIENT_ID },
      ],
    ] as const;

    it.each(INPUTS)(
      '★ คนกดจองยังไม่ onboard [%s] → ONBOARDING_REQUIRED ก่อนอ่านข้อมูลกลุ่ม/โปรไฟล์ใด ๆ',
      async (_label, target) => {
        prisma.user.findUnique.mockResolvedValue(NEW_ELDER);

        const err = await rejectionOf<GraphQLError>(
          service.createBookingOnBehalf(BOOKER_ID, { ...DTO, groupId: GROUP_ID, ...target }),
        );

        // ★ GraphQLError ที่ extensions.code ตรง ๆ — ไม่ใช่ ForbiddenException
        //   (ไม่งั้น code ไปอยู่ใน originalError และ FE อ่านไม่เจอ)
        expect(err).toBeInstanceOf(OnboardingRequiredError);
        expect(err.extensions).toEqual({ code: ONBOARDING_ERROR.REQUIRED });
        // ★ ตรวจ "คนกดจอง" ไม่ใช่สมาชิกที่ถูกจองให้
        expect(prisma.user.findUnique).toHaveBeenCalledWith({
          where: { id: BOOKER_ID },
          select: ONBOARDING_GATE_SELECT,
        });
        // ไม่ผ่านด่าน = ไม่มีเหตุให้ไปแตะข้อมูลกลุ่ม ความยินยอม หรือข้อมูลสุขภาพของใคร
        expect(prisma.familyGroupMember.findFirst).not.toHaveBeenCalled();
        expect(prisma.careRecipient.findUnique).not.toHaveBeenCalled();
        expect(prisma.careRecipient.findFirst).not.toHaveBeenCalled();
        expect(consent.findWithdrawnType).not.toHaveBeenCalled();
        expect(createRecord).not.toHaveBeenCalled();
      },
    );

    it('คนกดจอง onboard แล้ว → จองแทนได้ตามเดิม', async () => {
      prisma.careRecipient.findUnique.mockResolvedValue({
        id: RECIPIENT_ID,
        name: 'คุณยายสมศรี',
        familyGroupId: GROUP_ID,
        patientId: OWNER_ID,
        is_deleted: false,
      });
      prisma.familyGroupMember.findFirst.mockResolvedValue({ userId: OWNER_ID });

      await service.createBookingOnBehalf(BOOKER_ID, {
        ...DTO,
        groupId: GROUP_ID,
        careRecipientId: RECIPIENT_ID,
      });

      expect(createRecord).toHaveBeenCalledWith(
        BOOKER_ID,
        expect.objectContaining({ careRecipientId: RECIPIENT_ID }),
        expect.objectContaining({ familyGroupId: GROUP_ID }),
      );
    });

    it('★ ผู้ดูแล (role 2) ที่ไม่มีชื่อ-นามสกุล ยังจองแทนพ่อแม่ในกลุ่มได้', async () => {
      // PYG-412: กลุ่มครอบครัวไม่จำกัด role — ผู้ดูแลก็มีพ่อแม่ที่ต้องจองให้
      prisma.user.findUnique.mockResolvedValue({
        role: ROLE_ID.CAREGIVER,
        firstName: null,
        lastName: null,
      });
      prisma.familyGroupMember.findFirst.mockResolvedValue({ userId: OWNER_ID });
      prisma.careRecipient.findFirst.mockResolvedValue({
        id: RECIPIENT_ID,
        name: 'คุณยายสมศรี',
      });

      await service.createBookingOnBehalf(BOOKER_ID, {
        ...DTO,
        groupId: GROUP_ID,
        memberUserId: OWNER_ID,
      });

      expect(createRecord).toHaveBeenCalled();
    });

    it('ส่ง patientName มา → PATIENT_NAME_NOT_ALLOWED ก่อน (ตรวจรูปทรง input ก่อนอ่าน DB)', async () => {
      prisma.user.findUnique.mockResolvedValue(NEW_ELDER);

      await expect(
        service.createBookingOnBehalf(BOOKER_ID, {
          ...DTO,
          groupId: GROUP_ID,
          memberUserId: OWNER_ID,
          patientName: 'ชื่อที่พิมพ์เอง',
        }),
      ).rejects.toMatchObject({
        extensions: { code: FG_ERROR.PATIENT_NAME_NOT_ALLOWED },
      });
      expect(prisma.user.findUnique).not.toHaveBeenCalled();
    });
  });
});
