import { Test, TestingModule } from '@nestjs/testing';
import { ConflictException } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { GraphQLError } from 'graphql';
import { BookingService } from './booking.service';
import { PrismaService } from '../common/prisma.service';
import { OmiseService } from '../payment/omise/omise.service';
import { PaymentStateMachine } from '../payment/payment-state-machine';
import { JobQrService } from '../monitoring/qr/job-qr.service';
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

  beforeEach(async () => {
    // tx = client ที่ถูกส่งเข้า callback ของ $transaction
    tx = {
      booking: { create: jest.fn().mockResolvedValue(fakeCreatedBooking()) },
      familyGroupActivity: { create: jest.fn().mockResolvedValue({}) },
    };

    prisma = {
      careRecipient: { findUnique: jest.fn() },
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

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        BookingService,
        { provide: PrismaService, useValue: prisma },
        { provide: EventEmitter2, useValue: emitter },
        { provide: OmiseService, useValue: { voidCharge: jest.fn() } },
        { provide: PaymentStateMachine, useValue: { transition: jest.fn() } },
        { provide: JobQrService, useValue: jobQr },
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
  });

  // ── บั๊กที่แก้ไปพร้อมกัน: เช็คเวลาชนต่อ "ผู้รับบริการ" ───────────────────

  describe('time conflict — ผูกกับผู้รับบริการ ไม่ใช่คนจอง', () => {
    beforeEach(() => {
      prisma.careRecipient.findUnique.mockResolvedValue({
        id: RECIPIENT_ID,
        name: 'คุณยายสมศรี',
        familyGroupId: GROUP_ID,
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
