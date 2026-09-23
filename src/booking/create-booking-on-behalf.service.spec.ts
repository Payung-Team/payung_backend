import { Test, TestingModule } from '@nestjs/testing';
import { ConflictException } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { GraphQLError } from 'graphql';
import { BookingService } from './booking.service';
import { PrismaService } from '../common/prisma.service';
import { BookingSettlementService } from '../payment/settlement/booking-settlement.service';
import { JobQrService } from '../monitoring/qr/job-qr.service';
import { ConsentService } from '../consent/consent.service';
import { FG_ERROR } from '../family-group/family-group.errors';
import { ACTIVITY_ACTION, ACTIVITY_TARGET } from '../family-group/family-group.constants';

/**
 * PYG-424 — เทสของ "จองแทนในนามกลุ่มครอบครัว"
 *
 * แยกไฟล์จาก booking.service.spec.ts เดิม เพราะไฟล์นั้น mock prisma ไว้แค่
 * เท่าที่ confirmBooking/cancelBooking ต้องใช้ (ไม่มี careRecipient / booking.create)
 * ถ้าไปขยาย mock ในไฟล์นั้น เทสเดิม 20 กว่าตัวจะเสี่ยงพังจากการแก้ setup ร่วมกัน
 */

const BOOKER_ID = 'user-booker-1'; // สมาชิกที่กดจอง
const OWNER_ID = 'user-owner-2'; // เจ้าของโปรไฟล์ผู้รับบริการ (คนละคนกับคนกดจอง)
const GROUP_ID = '11111111-1111-4111-8111-111111111111';
const RECIPIENT_ID = '22222222-2222-4222-8222-222222222222';
const BOOKING_ID = 'booking-on-behalf-1';

/** input ครบชุดของ createBookingOnBehalf — override เฉพาะฟิลด์ที่เทสนั้นสนใจ */
function makeInput(overrides: Record<string, unknown> = {}) {
  return {
    groupId: GROUP_ID,
    careRecipientId: RECIPIENT_ID,
    tasks: ['อาบน้ำ'],
    serviceLocations: ['บ้าน'],
    serviceType: 'elderly_care',
    timeSlot: 'morning',
    startTime: '09:00:00',
    durationHours: 4,
    locationAddress: '123 ถนนสุขุมวิท',
    bookingDate: '2026-09-15',
    ...overrides,
  } as any;
}

/** แถว booking ที่ prisma คืนกลับมาหลัง create — ครบพอให้ toSummary() แปลงได้ */
function fakeCreatedBooking(overrides: Record<string, unknown> = {}) {
  return {
    id: BOOKING_ID,
    patientId: BOOKER_ID,
    status: 'unmatched',
    serviceType: 'elderly_care',
    timeSlot: 'morning',
    startTime: new Date('1970-01-01T09:00:00Z'),
    durationHours: 4,
    tasks: ['อาบน้ำ'],
    serviceLocations: ['บ้าน'],
    locationAddress: '123 ถนนสุขุมวิท',
    locationLat: null,
    locationLng: null,
    bookingDate: new Date('2026-09-15'),
    notes: null,
    estimatedCost: null,
    confirmedAt: null,
    disputeStatus: 'none',
    disputeReason: null,
    createdAt: new Date('2026-08-28T03:00:00Z'),
    caregiver: null,
    careRecipient: { name: 'คุณยายสมศรี' },
    ...overrides,
  };
}

describe('BookingService — createBookingOnBehalf (PYG-424)', () => {
  let service: BookingService;
  let prisma: any;
  let tx: any;
  let emitter: { emit: jest.Mock };
  // PYG-434: ใบ QR ที่ต้องถูกสร้างพร้อม booking ทุกใบ
  let jobQr: { createForBooking: jest.Mock };
  // PYG-540: ความยินยอมของเจ้าของข้อมูล
  let consent: { findWithdrawnType: jest.Mock; withdrawnUserIds: jest.Mock };

  beforeEach(async () => {
    // tx = client ที่ถูกส่งเข้า callback ของ $transaction
    tx = {
      booking: { create: jest.fn().mockResolvedValue(fakeCreatedBooking()) },
      // PYG-361: booking_tasks ถูกเขียนในทรานแซคชันเดียวกับ booking.create
      booking_tasks: { createMany: jest.fn().mockResolvedValue({ count: 0 }) },
      familyGroupActivity: { create: jest.fn().mockResolvedValue({}) },
    };

    prisma = {
      careRecipient: { findUnique: jest.fn(), findFirst: jest.fn(), create: jest.fn() },
      // PYG-516: เจ้าของโปรไฟล์ต้องยัง ACTIVE — เทสที่สนใจเคสตรงข้ามจะ override เอง
      familyGroupMember: {
        findFirst: jest.fn().mockResolvedValue({ userId: OWNER_ID }),
      },
      // PYG-516: ชื่อผู้รับบริการมาจากบัญชีของสมาชิก ไม่ใช่ค่าที่คนจองพิมพ์
      user: {
        findUnique: jest.fn().mockResolvedValue({
          firstName: 'สมศรี',
          lastName: 'ใจดี',
          displayName: 'ยายศรี',
        }),
      },
      caregiver: { findUnique: jest.fn() },
      booking: {
        // ไม่มีนัดหมายชนกัน เว้นแต่เทสนั้นจะ override เอง
        findMany: jest.fn().mockResolvedValue([]),
        create: jest.fn().mockResolvedValue(fakeCreatedBooking()),
      },
      $transaction: jest.fn((cb: (t: typeof tx) => unknown) => cb(tx)),
    };
    emitter = { emit: jest.fn() };
    jobQr = { createForBooking: jest.fn().mockResolvedValue(undefined) };
    consent = {
      findWithdrawnType: jest.fn().mockResolvedValue(null),
      withdrawnUserIds: jest.fn().mockResolvedValue(new Set()),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        BookingService,
        { provide: PrismaService, useValue: prisma },
        { provide: EventEmitter2, useValue: emitter },
        // PYG-461 เฟส 3a: dep ของ cancelBooking — ไฟล์นี้เทสการจองแทน ไม่ได้เทสการยกเลิก
        { provide: BookingSettlementService, useValue: { settle: jest.fn() } },
        { provide: JobQrService, useValue: jobQr },
        // PYG-540: ด่านความยินยอมของเจ้าของข้อมูล — ค่าเริ่มต้น = ไม่มีใครถอน
        { provide: ConsentService, useValue: consent },
      ],
    }).compile();

    service = module.get<BookingService>(BookingService);
  });

  // ── error case ที่การ์ดระบุไว้ตรง ๆ ──────────────────────────────────────

  describe('RECIPIENT_NOT_IN_GROUP', () => {
    it('โยน error เมื่อไม่มีโปรไฟล์ผู้รับบริการนั้นอยู่จริง', async () => {
      prisma.careRecipient.findUnique.mockResolvedValue(null);

      await expect(
        service.createBookingOnBehalf(BOOKER_ID, makeInput()),
      ).rejects.toMatchObject({
        extensions: { code: FG_ERROR.RECIPIENT_NOT_IN_GROUP },
      });

      // ต้องหยุดตั้งแต่ด่านแรก ห้ามสร้าง booking
      expect(prisma.booking.create).not.toHaveBeenCalled();
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('โยน error เมื่อโปรไฟล์มีอยู่ แต่อยู่คนละกลุ่ม', async () => {
      prisma.careRecipient.findUnique.mockResolvedValue({
        id: RECIPIENT_ID,
        name: 'คุณยายสมศรี',
        familyGroupId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', // กลุ่มอื่น
      });

      await expect(
        service.createBookingOnBehalf(BOOKER_ID, makeInput()),
      ).rejects.toMatchObject({
        extensions: { code: FG_ERROR.RECIPIENT_NOT_IN_GROUP },
      });
    });

    it('โปรไฟล์ส่วนตัว (familyGroupId = null) ก็จองแทนไม่ได้', async () => {
      prisma.careRecipient.findUnique.mockResolvedValue({
        id: RECIPIENT_ID,
        name: 'คุณยายสมศรี',
        familyGroupId: null,
      });

      await expect(
        service.createBookingOnBehalf(BOOKER_ID, makeInput()),
      ).rejects.toBeInstanceOf(GraphQLError);
    });

    it('ทั้งเคส "ไม่มีจริง" และ "อยู่คนละกลุ่ม" ต้องได้ code เดียวกัน (กันเดา id)', async () => {
      prisma.careRecipient.findUnique.mockResolvedValueOnce(null);
      const notFound = await service
        .createBookingOnBehalf(BOOKER_ID, makeInput())
        .catch((e) => e);

      prisma.careRecipient.findUnique.mockResolvedValueOnce({
        id: RECIPIENT_ID,
        name: 'คุณยายสมศรี',
        familyGroupId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      });
      const wrongGroup = await service
        .createBookingOnBehalf(BOOKER_ID, makeInput())
        .catch((e) => e);

      expect(notFound.extensions.code).toBe(wrongGroup.extensions.code);
      expect(notFound.message).toBe(wrongGroup.message);
    });
  });

  // ── happy path ───────────────────────────────────────────────────────────

  describe('happy path', () => {
    beforeEach(() => {
      prisma.careRecipient.findUnique.mockResolvedValue({
        id: RECIPIENT_ID,
        name: 'คุณยายสมศรี',
        familyGroupId: GROUP_ID,
        patientId: OWNER_ID,
        is_deleted: false,
      });
    });

    it('บันทึกบริบทกลุ่มลง booking: patientId + bookedBy = คนกดจอง, familyGroupId = กลุ่มที่ใช้จอง', async () => {
      await service.createBookingOnBehalf(BOOKER_ID, makeInput());

      expect(tx.booking.create).toHaveBeenCalledTimes(1);
      const data = tx.booking.create.mock.calls[0][0].data;

      // ★ patientId = คนกดจอง ไม่ใช่เจ้าของโปรไฟล์ — เพราะคนกดจองคือคนจ่ายเงิน
      expect(data.patientId).toBe(BOOKER_ID);
      expect(data.patientId).not.toBe(OWNER_ID);
      expect(data.bookedBy).toBe(BOOKER_ID);
      expect(data.familyGroupId).toBe(GROUP_ID);
      expect(data.careRecipientId).toBe(RECIPIENT_ID);
    });

    it('เขียนฟีดกิจกรรม BOOKING_ON_BEHALF ใน transaction เดียวกับ booking', async () => {
      await service.createBookingOnBehalf(BOOKER_ID, makeInput());

      // ★ ต้องผ่าน $transaction เท่านั้น ไม่ใช่ create เดี่ยว ๆ
      expect(prisma.$transaction).toHaveBeenCalledTimes(1);
      expect(prisma.booking.create).not.toHaveBeenCalled();

      expect(tx.familyGroupActivity.create).toHaveBeenCalledTimes(1);
      const activity = tx.familyGroupActivity.create.mock.calls[0][0].data;
      expect(activity).toMatchObject({
        groupId: GROUP_ID,
        actorId: BOOKER_ID,
        action: ACTIVITY_ACTION.BOOKING_ON_BEHALF,
        targetType: ACTIVITY_TARGET.BOOKING,
        targetId: BOOKING_ID,
      });
      // ชื่อผู้รับบริการถูกแช่ไว้ในฟีด เพื่อให้อ่านย้อนหลังได้แม้โปรไฟล์จะถูกลบ
      expect(activity.metadata.recipientName).toBe('คุณยายสมศรี');
    });

    it('คืน BookingSummary ที่ FE ใช้ได้ทันที', async () => {
      const result = await service.createBookingOnBehalf(BOOKER_ID, makeInput());

      expect(result.id).toBe(BOOKING_ID);
      expect(result.status).toBe('unmatched');
      expect(result.bookingDate).toBe('2026-09-15');
      expect(result.careRecipientName).toBe('คุณยายสมศรี');
    });

    it('เลือกโปรไฟล์ส่วนตัวที่สมาชิกเป้าหมายเคยบันทึกไว้ได้', async () => {
      prisma.familyGroupMember.findFirst.mockResolvedValue({ userId: OWNER_ID });
      prisma.careRecipient.findFirst.mockResolvedValue({
        id: RECIPIENT_ID,
        name: 'คุณยายสมศรี',
      });

      await service.createBookingOnBehalf(
        BOOKER_ID,
        makeInput({ memberUserId: OWNER_ID }),
      );

      expect(prisma.careRecipient.findFirst).toHaveBeenCalledWith({
        where: {
          id: RECIPIENT_ID,
          patientId: OWNER_ID,
          is_deleted: false,
          OR: [{ familyGroupId: null }, { familyGroupId: GROUP_ID }],
        },
        select: { id: true, name: true },
      });
      expect(tx.booking.create.mock.calls[0][0].data.careRecipientId).toBe(RECIPIENT_ID);
    });

    // ── PYG-385 (D2): memberDetails ลง bookings.member_details (JSONB) ────────
    it('บันทึก memberDetails ลง booking เมื่อสมาชิกกรอกอาการ/รายละเอียดมา', async () => {
      const memberDetails = {
        conditions: ['เบาหวาน', 'ความดัน'],
        medicines: 'ยาลดความดัน เช้า-เย็น',
        allergies: 'แพ้เพนิซิลลิน',
        careInstructions: 'ต้องพยุงเดิน ห้ามอยู่คนเดียว',
      };

      await service.createBookingOnBehalf(BOOKER_ID, makeInput({ memberDetails }));

      const data = tx.booking.create.mock.calls[0][0].data;
      expect(data.memberDetails).toEqual(memberDetails);
    });

    it('ไม่กรอก memberDetails → ไม่แตะคอลัมน์ (คง NULL ตามพฤติกรรมเดิม)', async () => {
      await service.createBookingOnBehalf(BOOKER_ID, makeInput());

      const data = tx.booking.create.mock.calls[0][0].data;
      expect(data.memberDetails).toBeUndefined();
    });
  });


  // ── PYG-516: ล็อกชื่อ-นามสกุล + ตรวจสมาชิก ACTIVE ─────────────────────────
  //
  // ที่มา: ฟีดแบ็กอาจารย์ Sprint 9 ข้อ 6 (= PYG-495) — คนจองพิมพ์ชื่อใครก็ได้ลงใบจอง
  describe('ล็อกชื่อผู้รับบริการ (PYG-516)', () => {
    beforeEach(() => {
      prisma.careRecipient.findUnique.mockResolvedValue({
        id: RECIPIENT_ID,
        name: 'คุณยายสมศรี',
        familyGroupId: GROUP_ID,
        patientId: OWNER_ID,
        is_deleted: false,
      });
      tx.booking.create.mockResolvedValue(fakeCreatedBooking());
    });

    it('★ ส่ง patientName มา → ปฏิเสธ และไม่สร้างอะไรเลย', async () => {
      await expect(
        service.createBookingOnBehalf(
          BOOKER_ID,
          makeInput({ memberUserId: OWNER_ID, careRecipientId: undefined, patientName: 'ชื่อปลอม' }),
        ),
      ).rejects.toMatchObject({
        extensions: { code: FG_ERROR.PATIENT_NAME_NOT_ALLOWED },
      });

      // ★ ด่านต้องอยู่ก่อนทุกเส้นทาง — ไม่ใช่ "รับแล้วเงียบ ๆ ไม่ใช้"
      //   ถ้าเงียบ FE จะคิดว่าชื่อที่พิมพ์ถูกบันทึก แต่ผู้ดูแลเห็นอีกชื่อหนึ่ง
      expect(prisma.$transaction).not.toHaveBeenCalled();
      expect(prisma.careRecipient.create).not.toHaveBeenCalled();
    });

    it('★ สมาชิกยังไม่มีโปรไฟล์ → สร้างใบใหม่ด้วยชื่อจากบัญชี ไม่ใช่ชื่อที่พิมพ์', async () => {
      prisma.careRecipient.findFirst.mockResolvedValue(null);
      prisma.careRecipient.create.mockResolvedValue({ id: 'cr-new', name: 'สมศรี ใจดี' });

      await service.createBookingOnBehalf(
        BOOKER_ID,
        makeInput({ memberUserId: OWNER_ID, careRecipientId: undefined }),
      );

      const created = prisma.careRecipient.create.mock.calls[0][0] as {
        data: { name: string; patientId: string };
      };
      expect(created.data.name).toBe('สมศรี ใจดี');
      expect(created.data.patientId).toBe(OWNER_ID);
    });

    it('บัญชีมีแต่ display_name (สมัครก่อน Onboarding) → ใช้ display_name', async () => {
      prisma.user.findUnique.mockResolvedValue({
        firstName: null,
        lastName: null,
        displayName: 'ยายศรี',
      });
      prisma.careRecipient.findFirst.mockResolvedValue(null);
      prisma.careRecipient.create.mockResolvedValue({ id: 'cr-new', name: 'ยายศรี' });

      await service.createBookingOnBehalf(
        BOOKER_ID,
        makeInput({ memberUserId: OWNER_ID, careRecipientId: undefined }),
      );

      const created = prisma.careRecipient.create.mock.calls[0][0] as {
        data: { name: string };
      };
      expect(created.data.name).toBe('ยายศรี');
    });

    it('★ บัญชีไม่มีชื่อเลย → ปฏิเสธ ไม่เดาชื่อให้', async () => {
      prisma.user.findUnique.mockResolvedValue({
        firstName: null,
        lastName: null,
        displayName: null,
      });
      prisma.careRecipient.findFirst.mockResolvedValue(null);

      // ★ ใบงานที่ผู้ดูแลถือไปต้องระบุตัวคนที่จะไปดูแลได้จริง
      //   ชื่อหลอกแบบ "ผู้ใช้ #xxxx" อันตรายกว่าการจองไม่ผ่าน
      await expect(
        service.createBookingOnBehalf(
          BOOKER_ID,
          makeInput({ memberUserId: OWNER_ID, careRecipientId: undefined }),
        ),
      ).rejects.toMatchObject({
        extensions: { code: FG_ERROR.MEMBER_NAME_MISSING },
      });
      expect(prisma.careRecipient.create).not.toHaveBeenCalled();
    });

    it('★ bookings.patient_name = ชื่อจากโปรไฟล์ ไม่ใช่ค่าที่คนจองส่งมา', async () => {
      await service.createBookingOnBehalf(BOOKER_ID, makeInput());

      const data = tx.booking.create.mock.calls[0][0].data as { patientName: string };
      // ★ ชื่อนี้คือสิ่งที่ผู้ดูแลเห็นบนใบงาน (booking.service.ts:1189 คืนออกไป)
      expect(data.patientName).toBe('คุณยายสมศรี');
    });
  });

  describe('ตรวจสมาชิก ACTIVE (PYG-516)', () => {
    beforeEach(() => {
      prisma.careRecipient.findUnique.mockResolvedValue({
        id: RECIPIENT_ID,
        name: 'คุณยายสมศรี',
        familyGroupId: GROUP_ID,
        patientId: OWNER_ID,
        is_deleted: false,
      });
      tx.booking.create.mockResolvedValue(fakeCreatedBooking());
    });

    it('★ เส้นทาง careRecipientId: เจ้าของออกจากกลุ่มแล้ว → จองไม่ได้', async () => {
      prisma.familyGroupMember.findFirst.mockResolvedValue(null);

      await expect(
        service.createBookingOnBehalf(BOOKER_ID, makeInput()),
      ).rejects.toMatchObject({
        extensions: { code: FG_ERROR.RECIPIENT_NOT_IN_GROUP },
      });
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('ตรวจ ACTIVE ด้วย "เจ้าของโปรไฟล์" ไม่ใช่คนกดจอง', async () => {
      await service.createBookingOnBehalf(BOOKER_ID, makeInput());

      const query = prisma.familyGroupMember.findFirst.mock.calls[0][0] as {
        where: Record<string, unknown>;
      };
      expect(query.where).toMatchObject({
        groupId: GROUP_ID,
        userId: OWNER_ID,
        status: 'ACTIVE',
      });
    });

    it('โปรไฟล์ที่ถูกลบไปแล้ว → จองไม่ได้', async () => {
      prisma.careRecipient.findUnique.mockResolvedValue({
        id: RECIPIENT_ID,
        name: 'คุณยายสมศรี',
        familyGroupId: GROUP_ID,
        patientId: OWNER_ID,
        is_deleted: true,
      });

      await expect(
        service.createBookingOnBehalf(BOOKER_ID, makeInput()),
      ).rejects.toMatchObject({
        extensions: { code: FG_ERROR.RECIPIENT_NOT_IN_GROUP },
      });
    });

    it('★ เจ้าของออกจากกลุ่ม กับ โปรไฟล์ไม่มีจริง → code เดียวกัน (กันไล่เดา id)', async () => {
      prisma.familyGroupMember.findFirst.mockResolvedValueOnce(null);
      const leftGroup = await service
        .createBookingOnBehalf(BOOKER_ID, makeInput())
        .catch((e) => e);

      prisma.careRecipient.findUnique.mockResolvedValueOnce(null);
      const notFound = await service
        .createBookingOnBehalf(BOOKER_ID, makeInput())
        .catch((e) => e);

      expect(leftGroup.extensions.code).toBe(notFound.extensions.code);
      expect(leftGroup.message).toBe(notFound.message);
    });
  });

  // ── ช่องที่ยัง "แก้ได้" ตอนจองแทน ────────────────────────────────────────
  describe('ช่องที่ยังแก้ได้ (PYG-516)', () => {
    beforeEach(() => {
      prisma.careRecipient.findUnique.mockResolvedValue({
        id: RECIPIENT_ID,
        name: 'คุณยายสมศรี',
        familyGroupId: GROUP_ID,
        patientId: OWNER_ID,
        is_deleted: false,
      });
      tx.booking.create.mockResolvedValue(fakeCreatedBooking());
    });

  it('★ ที่อยู่/ข้อมูลสุขภาพยังแก้ได้ตอนจอง (ล็อกแค่ชื่อ)', async () => {
    const memberDetails = {
      conditions: ['เบาหวาน'],
      medicines: 'ยาลดความดัน',
      allergies: 'แพ้เพนิซิลลิน',
      careInstructions: 'ต้องพยุงเดิน',
    };

    await service.createBookingOnBehalf(BOOKER_ID, makeInput({ memberDetails }));

    const data = tx.booking.create.mock.calls[0][0].data as {
      memberDetails: typeof memberDetails;
    };
    expect(data.memberDetails).toEqual(memberDetails);
  });
  });

  // ── บั๊กที่แก้ไปพร้อมกัน: เช็คเวลาชนต่อ "ผู้รับบริการ" ───────────────────

  describe('time conflict — ผูกกับผู้รับบริการ ไม่ใช่คนจอง', () => {
    beforeEach(() => {
      prisma.careRecipient.findUnique.mockResolvedValue({
        id: RECIPIENT_ID,
        name: 'คุณยายสมศรี',
        familyGroupId: GROUP_ID,
        patientId: OWNER_ID,
        is_deleted: false,
      });
    });

    it('กรองนัดหมายที่ชนกันด้วย careRecipientId ไม่ใช่ patientId', async () => {
      await service.createBookingOnBehalf(BOOKER_ID, makeInput());

      const where = prisma.booking.findMany.mock.calls[0][0].where;
      expect(where.careRecipientId).toBe(RECIPIENT_ID);
      // ★ ถ้ายังกรองด้วย patientId อยู่ = ลูกจองให้แม่แล้วจองให้พ่อเวลาเดียวกันไม่ได้
      expect(where.patientId).toBeUndefined();
    });

    it('ผู้รับบริการคนเดิมมีนัดซ้อนเวลา → ConflictException (ยายอยู่สองที่ไม่ได้)', async () => {
      prisma.booking.findMany.mockResolvedValue([
        { startTime: new Date('1970-01-01T10:00:00Z'), durationHours: 3 }, // 10:00–13:00
      ]);

      // ใบใหม่ 09:00–13:00 → ทับกับของเดิม
      await expect(
        service.createBookingOnBehalf(BOOKER_ID, makeInput()),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('ข้อความ error พูดถึง "ผู้รับบริการ" ไม่ใช่ "คุณ" เวลาจองแทน', async () => {
      prisma.booking.findMany.mockResolvedValue([
        { startTime: new Date('1970-01-01T09:00:00Z'), durationHours: 2 },
      ]);

      const err = await service
        .createBookingOnBehalf(BOOKER_ID, makeInput())
        .catch((e) => e);

      expect(err.message).toContain('ผู้รับบริการคนนี้');
    });

    it('นัดที่ไม่ทับเวลากัน → จองได้ตามปกติ', async () => {
      prisma.booking.findMany.mockResolvedValue([
        { startTime: new Date('1970-01-01T14:00:00Z'), durationHours: 2 }, // 14:00–16:00
      ]);

      // ใบใหม่ 09:00–13:00 → ไม่ทับ
      await expect(
        service.createBookingOnBehalf(BOOKER_ID, makeInput()),
      ).resolves.toBeDefined();
    });
  });

  // ── กันการจองปกติพัง (regression) ────────────────────────────────────────

  describe('การจองปกติต้องไม่เปลี่ยนพฤติกรรม', () => {
    it('ไม่มี careRecipientId → ยังกรองนัดชนด้วย patientId เหมือนเดิม', async () => {
      await service.createBooking(BOOKER_ID, makeInput({
        careRecipientId: undefined,
        groupId: undefined,
      }));

      const where = prisma.booking.findMany.mock.calls[0][0].where;
      expect(where.patientId).toBe(BOOKER_ID);
      expect(where.careRecipientId).toBeUndefined();
    });

    /**
     * ⚠ เทสนี้ถูกแก้ใน PYG-434 — ของเดิมเขียนว่า "จองปกติไม่แตะ transaction"
     *
     * เหตุผลที่เปลี่ยน: ตอนนี้ booking ทุกใบต้องเกิดพร้อม "ใบ QR" ใน transaction
     * เดียวกัน (AC: ทุก booking ใหม่มี JobSession) → จองปกติจึงใช้ transaction ด้วย
     * สิ่งที่ยังต้องเป็นจริงเหมือนเดิมคือ "จองปกติไม่เขียนฟีดกิจกรรมของกลุ่ม"
     * ซึ่งเป็นประเด็นจริง ๆ ของ PYG-424 ที่เทสนี้ตั้งใจปกป้อง
     */
    it('จองปกติไม่เขียนฟีดกิจกรรม (แต่ยังอยู่ใน transaction เพราะต้องสร้างใบ QR)', async () => {
      await service.createBooking(BOOKER_ID, makeInput({
        careRecipientId: undefined,
        groupId: undefined,
      }));

      expect(prisma.$transaction).toHaveBeenCalledTimes(1);
      expect(tx.booking.create).toHaveBeenCalledTimes(1);
      expect(tx.familyGroupActivity.create).not.toHaveBeenCalled();

      // บริบทกลุ่มต้องเป็น null ทั้งคู่
      const data = tx.booking.create.mock.calls[0][0].data;
      expect(data.familyGroupId).toBeNull();
      expect(data.bookedBy).toBeNull();
    });
  });

  // ── PYG-434: ใบ QR ต้องเกิดพร้อม booking ทุกเส้นทาง ─────────────────────

  describe('ใบ QR (PYG-434)', () => {
    it('★ จองแทน → สร้างใบ QR ใน transaction เดียวกับ booking', async () => {
      // โปรไฟล์อยู่ในกลุ่มจริง → ผ่านด่านแรกไปถึงขั้นสร้าง booking ได้
      prisma.careRecipient.findUnique.mockResolvedValue({
        id: RECIPIENT_ID,
        name: 'คุณยายสมศรี',
        familyGroupId: GROUP_ID,
        patientId: OWNER_ID,
        is_deleted: false,
      });

      await service.createBookingOnBehalf(BOOKER_ID, makeInput());

      expect(jobQr.createForBooking).toHaveBeenCalledTimes(1);
      // argument แรกต้องเป็น tx ตัวเดียวกับที่สร้าง booking ไม่ใช่ prisma client ปกติ
      // ถ้าส่งผิดตัว ใบ QR จะถูก commit แยกจาก booking แล้ว atomicity หายไปเงียบ ๆ
      const [txArg, bookingArg] = jobQr.createForBooking.mock.calls[0];
      expect(txArg).toBe(tx);
      expect(bookingArg.id).toBe(BOOKING_ID);
    });

    it('★ จองปกติ (ไม่ผ่านกลุ่ม) → ก็ต้องได้ใบ QR เหมือนกัน', async () => {
      await service.createBooking(BOOKER_ID, makeInput({
        careRecipientId: undefined,
        groupId: undefined,
      }));

      expect(jobQr.createForBooking).toHaveBeenCalledTimes(1);
      expect(jobQr.createForBooking.mock.calls[0][0]).toBe(tx);
    });

    it('สร้าง booking ไม่สำเร็จ → ต้องไม่มีการสร้างใบ QR', async () => {
      // นัดชนกัน → โยน ConflictException ตั้งแต่ก่อนเข้า transaction
      prisma.booking.findMany.mockResolvedValue([
        { startTime: new Date('1970-01-01T09:00:00Z'), durationHours: 4 },
      ]);

      await expect(
        service.createBooking(BOOKER_ID, makeInput({
          careRecipientId: undefined,
          groupId: undefined,
        })),
      ).rejects.toThrow(ConflictException);

      expect(jobQr.createForBooking).not.toHaveBeenCalled();
    });
  });
});
