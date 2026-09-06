/**
 * Unit tests สำหรับ JobQrService (PYG-434 · การ์ดแม่ PYG-433)
 *
 * ครอบคลุม 3 ส่วนตาม AC ของการ์ด:
 *  A. createForBooking() — ทุก booking ใหม่ได้ session PENDING + เก็บ "แค่ hash"
 *  B. jobQr()            — patient เจ้าของดึง QR ได้ / คนอื่นดึงไม่ได้ / งานยกเลิกแล้วใช้ไม่ได้
 *  C. token round-trip   — sha256(token ที่คืนให้ patient) ต้องตรงกับ hash ที่เก็บไว้ตอนสร้าง
 *                          (ถ้าข้อนี้พัง = สแกนจริงจะไม่มีวันผ่าน แม้ทุกอย่างอื่นดูถูกหมด)
 *
 * mock PrismaService / ClockService ทั้งหมด → ไม่แตะ DB จริง
 *
 * ★ ธีมที่ทดสอบซ้ำ ๆ ตลอดไฟล์: token ดิบต้องไม่มีวันไปโผล่ในดีบี
 */
import { Test, TestingModule } from '@nestjs/testing';
import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { createHash } from 'crypto';
import { PrismaService } from '../../common/prisma.service';
import { ClockService } from '../../common/clock.service';
import { JobQrService } from './job-qr.service';
import { JOB_SESSION_STATUS } from './qr.constants';

// ต้องตั้งกุญแจ "ก่อน" สร้าง service เพราะ resolveSecret() อ่าน ENV ตอน constructor
// ถ้าไม่ตั้ง service จะสุ่มกุญแจให้เอง (ซึ่งเทสก็ยังผ่าน แต่จะไม่ได้ทดสอบเส้นทางจริง)
process.env.QR_TOKEN_SECRET = 'test-secret-that-is-long-enough-32+';

const PATIENT_ID = 'user-pt-0001';
const OTHER_PATIENT_ID = 'user-pt-9999';
const BOOKING_ID = '11111111-1111-4111-8111-111111111111';
const SESSION_ID = '22222222-2222-4222-8222-222222222222';

/**
 * งานตัวอย่าง: 13 มิ.ย. 2026 เวลา 09:00 น. (เวลาไทย) ยาว 4 ชั่วโมง
 *
 * แปลงเป็นเวลาจริงบนไทม์ไลน์ (ไทย = UTC+7):
 *   เริ่มงาน   09:00 ไทย = 2026-06-13T02:00:00Z
 *   เลิกงาน   13:00 ไทย = 2026-06-13T06:00:00Z
 * ช่วงที่ QR ใช้ได้ (offset 60 นาที / grace 120 นาที ตามค่า default):
 *   validFrom  = 01:00:00Z   (08:00 ไทย)
 *   validUntil = 08:00:00Z   (15:00 ไทย)
 */
const BOOKING_DATE = new Date(Date.UTC(2026, 5, 13)); // คอลัมน์ DATE → เที่ยงคืน UTC
const START_TIME = new Date('1970-01-01T09:00:00Z'); // คอลัมน์ TIME → 09:00 ไทย
const DURATION_HOURS = 4;
const EXPECTED_VALID_FROM = new Date('2026-06-13T01:00:00Z');
const EXPECTED_VALID_UNTIL = new Date('2026-06-13T08:00:00Z');

/** เวลาปัจจุบันของเทสส่วนใหญ่ — 10:00 ไทย = อยู่ในช่วงที่สแกนได้ */
const NOW = new Date('2026-06-13T03:00:00Z');

/** แถว job_sessions ที่ jobQr() อ่านมาได้ */
function fakeSession(overrides: Record<string, unknown> = {}) {
  return {
    id: SESSION_ID,
    bookingId: BOOKING_ID,
    status: JOB_SESSION_STATUS.PENDING,
    validFrom: EXPECTED_VALID_FROM,
    validUntil: EXPECTED_VALID_UNTIL,
    ...overrides,
  };
}

/** booking รูปทรงที่ jobQr() select มา */
function fakeBooking(overrides: Record<string, unknown> = {}) {
  return {
    id: BOOKING_ID,
    patientId: PATIENT_ID,
    status: 'confirmed',
    jobSession: fakeSession(),
    ...overrides,
  };
}

describe('JobQrService (PYG-434)', () => {
  let service: JobQrService;
  let prisma: {
    booking: { findUnique: jest.Mock };
    jobSession: { update: jest.Mock };
  };
  let clock: { now: jest.Mock };

  beforeEach(async () => {
    prisma = {
      booking: { findUnique: jest.fn() },
      jobSession: { update: jest.fn() },
    };
    clock = { now: jest.fn().mockReturnValue(NOW) };

    const moduleRef: TestingModule = await Test.createTestingModule({
      providers: [
        JobQrService,
        { provide: PrismaService, useValue: prisma },
        { provide: ClockService, useValue: clock },
      ],
    }).compile();

    service = moduleRef.get(JobQrService);
  });

  // ════════════════════════════════════════════════════════════════════
  // A. createForBooking()
  // ════════════════════════════════════════════════════════════════════
  describe('createForBooking()', () => {
    /** tx ปลอม — เก็บ data ที่ถูกส่งเข้า create ไว้ให้เทสตรวจ */
    function fakeTx() {
      return { jobSession: { create: jest.fn().mockResolvedValue({}) } } as any;
    }

    const booking = {
      id: BOOKING_ID,
      bookingDate: BOOKING_DATE,
      startTime: START_TIME,
      durationHours: DURATION_HOURS,
    };

    it('สร้าง session สถานะ PENDING ผูกกับ booking ที่ส่งเข้ามา', async () => {
      const tx = fakeTx();
      await service.createForBooking(tx, booking);

      expect(tx.jobSession.create).toHaveBeenCalledTimes(1);
      const { data } = tx.jobSession.create.mock.calls[0][0];
      expect(data.bookingId).toBe(BOOKING_ID);
      expect(data.status).toBe(JOB_SESSION_STATUS.PENDING);
    });

    it('★ เก็บ "แค่ sha256 hex 64 ตัว" ไม่มี token ดิบอยู่ในแถวเลย', async () => {
      const tx = fakeTx();
      await service.createForBooking(tx, booking);

      const { data } = tx.jobSession.create.mock.calls[0][0];

      // รูปทรงต้องผ่าน CHECK "job_sessions_token_hash_check" ในดีบี
      expect(data.tokenHash).toMatch(/^[0-9a-f]{64}$/);

      // ไม่มีคีย์ไหนในแถวที่หน้าตาเหมือน token ดิบ (base64url 43 ตัว) หลุดเข้าไป
      const values = Object.values(data).filter((v) => typeof v === 'string');
      expect(values.some((v) => /^[A-Za-z0-9_-]{43}$/.test(v))).toBe(false);
    });

    it('คำนวณช่วงเวลาจากตารางงาน: เปิดก่อนเริ่ม 60 นาที และปิดหลังเลิก 120 นาที', async () => {
      const tx = fakeTx();
      await service.createForBooking(tx, booking);

      const { data } = tx.jobSession.create.mock.calls[0][0];
      expect(data.validFrom).toEqual(EXPECTED_VALID_FROM);
      expect(data.validUntil).toEqual(EXPECTED_VALID_UNTIL);
    });

    it('booking คนละใบได้ token คนละตัว (id ต่างกัน → hash ต่างกัน)', async () => {
      const txA = fakeTx();
      const txB = fakeTx();
      await service.createForBooking(txA, booking);
      await service.createForBooking(txB, { ...booking, id: 'other-booking' });

      const hashA = txA.jobSession.create.mock.calls[0][0].data.tokenHash;
      const hashB = txB.jobSession.create.mock.calls[0][0].data.tokenHash;
      expect(hashA).not.toBe(hashB);
    });
  });

  // ════════════════════════════════════════════════════════════════════
  // B. jobQr() — ด่านตรวจ
  // ════════════════════════════════════════════════════════════════════
  describe('jobQr() — ด่านตรวจ', () => {
    it('patient เจ้าของงานดึง QR ได้', async () => {
      prisma.booking.findUnique.mockResolvedValue(fakeBooking());

      const result = await service.jobQr(PATIENT_ID, BOOKING_ID);

      expect(result.bookingId).toBe(BOOKING_ID);
      expect(result.token).toEqual(expect.any(String));
      expect(result.status).toBe(JOB_SESSION_STATUS.PENDING);
    });

    it('ไม่มี booking นี้ → NotFound', async () => {
      prisma.booking.findUnique.mockResolvedValue(null);

      await expect(service.jobQr(PATIENT_ID, BOOKING_ID)).rejects.toThrow(
        NotFoundException,
      );
    });

    it('★ patient คนอื่นดึง QR ของคนอื่นไม่ได้ → Forbidden', async () => {
      prisma.booking.findUnique.mockResolvedValue(fakeBooking());

      await expect(service.jobQr(OTHER_PATIENT_ID, BOOKING_ID)).rejects.toThrow(
        ForbiddenException,
      );
    });

    it.each(['cancelled', 'rejected'])(
      'งานสถานะ %s → QR ใช้ไม่ได้ (BadRequest)',
      async (status) => {
        prisma.booking.findUnique.mockResolvedValue(fakeBooking({ status }));

        await expect(service.jobQr(PATIENT_ID, BOOKING_ID)).rejects.toThrow(
          BadRequestException,
        );
      },
    );

    it('booking เก่าที่ไม่มี session (ก่อน migration) → NotFound พร้อมข้อความอธิบาย', async () => {
      prisma.booking.findUnique.mockResolvedValue(
        fakeBooking({ jobSession: null }),
      );

      await expect(service.jobQr(PATIENT_ID, BOOKING_ID)).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  // ════════════════════════════════════════════════════════════════════
  // B2. jobQr() — ค่าที่คำนวณตอนอ่าน
  // ════════════════════════════════════════════════════════════════════
  describe('jobQr() — isActive / nextAction', () => {
    it('PENDING + อยู่ในช่วงเวลา → nextAction = CHECK_IN และ isActive = true', async () => {
      prisma.booking.findUnique.mockResolvedValue(fakeBooking());

      const result = await service.jobQr(PATIENT_ID, BOOKING_ID);

      expect(result.nextAction).toBe('CHECK_IN');
      expect(result.isActive).toBe(true);
    });

    it('CHECKED_IN → nextAction = CHECK_OUT (QR ใบเดิม แต่ action เปลี่ยนตามสถานะ)', async () => {
      prisma.booking.findUnique.mockResolvedValue(
        fakeBooking({
          jobSession: fakeSession({
            status: JOB_SESSION_STATUS.CHECKED_IN,
          }),
        }),
      );

      const result = await service.jobQr(PATIENT_ID, BOOKING_ID);

      expect(result.nextAction).toBe('CHECK_OUT');
      expect(result.isActive).toBe(true);
    });

    it('CHECKED_OUT → ไม่เหลือ action และ isActive = false', async () => {
      prisma.booking.findUnique.mockResolvedValue(
        fakeBooking({
          jobSession: fakeSession({
            status: JOB_SESSION_STATUS.CHECKED_OUT,
          }),
        }),
      );

      const result = await service.jobQr(PATIENT_ID, BOOKING_ID);

      expect(result.nextAction).toBeUndefined();
      expect(result.isActive).toBe(false);
    });

    it('ยังไม่ถึงเวลา → isActive = false แต่ยังคืน token ให้ (FE เอาไปโชว์ "ยังไม่ถึงเวลา")', async () => {
      // 07:00 ไทย = ก่อน validFrom (08:00 ไทย) หนึ่งชั่วโมง
      clock.now.mockReturnValue(new Date('2026-06-13T00:00:00Z'));
      prisma.booking.findUnique.mockResolvedValue(fakeBooking());

      const result = await service.jobQr(PATIENT_ID, BOOKING_ID);

      expect(result.isActive).toBe(false);
      expect(result.token).toEqual(expect.any(String));
    });

    it('เลยเวลาแล้ว → isActive = false', async () => {
      // 16:00 ไทย = หลัง validUntil (15:00 ไทย)
      clock.now.mockReturnValue(new Date('2026-06-13T09:00:00Z'));
      prisma.booking.findUnique.mockResolvedValue(fakeBooking());

      const result = await service.jobQr(PATIENT_ID, BOOKING_ID);

      expect(result.isActive).toBe(false);
    });
  });

  // ════════════════════════════════════════════════════════════════════
  // C. token round-trip — ข้อที่สำคัญที่สุดของไฟล์นี้
  // ════════════════════════════════════════════════════════════════════
  describe('token round-trip (สร้าง → อ่าน → hash ตรงกัน)', () => {
    it('★ sha256(token ที่ patient ได้รับ) = tokenHash ที่เก็บไว้ตอนสร้าง', async () => {
      // ① สร้าง session แล้วจับค่าที่ถูกเขียนลงดีบี
      const tx = {
        jobSession: { create: jest.fn().mockResolvedValue({}) },
      } as any;
      await service.createForBooking(tx, {
        id: BOOKING_ID,
        bookingDate: BOOKING_DATE,
        startTime: START_TIME,
        durationHours: DURATION_HOURS,
      });
      const stored = tx.jobSession.create.mock.calls[0][0].data;

      // ② อ่านกลับมาผ่าน jobQr() เหมือนที่ patient เปิดหน้า booking detail
      prisma.booking.findUnique.mockResolvedValue(
        fakeBooking({
          jobSession: fakeSession({ id: stored.id }),
        }),
      );
      const result = await service.jobQr(PATIENT_ID, BOOKING_ID);

      // ③ token ที่ได้ต้อง hash แล้วตรงกับที่เก็บไว้
      //    ถ้าข้อนี้พัง = PYG-435 จะหา session ไม่เจอ และสแกนจริงจะไม่มีวันผ่าน
      expect(createHash('sha256').update(result.token).digest('hex')).toBe(
        stored.tokenHash,
      );
      expect(service.hashToken(result.token)).toBe(stored.tokenHash);
    });

    it('เรียก jobQr ซ้ำกี่ครั้งก็ได้ token เดิม (QR ใบเดียวต่อ booking ปริ้นท์แปะไว้ได้)', async () => {
      prisma.booking.findUnique.mockResolvedValue(fakeBooking());

      const first = await service.jobQr(PATIENT_ID, BOOKING_ID);
      const second = await service.jobQr(PATIENT_ID, BOOKING_ID);

      expect(first.token).toBe(second.token);
    });

    it('token เป็น base64url ยาว 43 ตัว (= 32 ไบต์ ตามที่การ์ดขอ)', async () => {
      prisma.booking.findUnique.mockResolvedValue(fakeBooking());

      const result = await service.jobQr(PATIENT_ID, BOOKING_ID);

      expect(result.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    });
  });

  // ════════════════════════════════════════════════════════════════════
  // D. resyncValidityWindow() — เตรียมไว้ให้ฟีเจอร์เลื่อนนัด
  // ════════════════════════════════════════════════════════════════════
  describe('resyncValidityWindow()', () => {
    it('อัปเดตช่วงเวลาใหม่ตามตารางงานล่าสุด โดยไม่แตะ token', async () => {
      prisma.booking.findUnique.mockResolvedValue({
        id: BOOKING_ID,
        bookingDate: BOOKING_DATE,
        startTime: START_TIME,
        durationHours: DURATION_HOURS,
        jobSession: { id: SESSION_ID },
      });

      await service.resyncValidityWindow(BOOKING_ID);

      expect(prisma.jobSession.update).toHaveBeenCalledWith({
        where: { id: SESSION_ID },
        data: {
          validFrom: EXPECTED_VALID_FROM,
          validUntil: EXPECTED_VALID_UNTIL,
          updatedAt: NOW,
        },
      });
    });

    it('booking ที่ไม่มี session → ไม่ทำอะไรและไม่ error', async () => {
      prisma.booking.findUnique.mockResolvedValue({
        id: BOOKING_ID,
        bookingDate: BOOKING_DATE,
        startTime: START_TIME,
        durationHours: DURATION_HOURS,
        jobSession: null,
      });

      await expect(
        service.resyncValidityWindow(BOOKING_ID),
      ).resolves.toBeUndefined();
      expect(prisma.jobSession.update).not.toHaveBeenCalled();
    });
  });
});
