/**
 * Unit tests สำหรับ MonitoringService (PYG-352 / การ์ดแม่ PYG-351)
 *
 * ครอบคลุม 2 ส่วน:
 *  A. evaluate() — กฎการติดธงล้วน ๆ (ไม่แตะ DB) = หัวใจของการ์ดนี้
 *  B. checkInBooking() — ด่านตรวจ + idempotency + transaction
 *
 * mock PrismaService/SupabaseService/ClockService ทั้งหมด → ไม่แตะ DB จริง
 *
 * ★ ธีมที่ทดสอบซ้ำ ๆ ตลอดไฟล์: GPS ต้องไม่เคยทำให้เช็คอินล้มเหลว
 */
import { Test, TestingModule } from '@nestjs/testing';
import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { MonitoringService } from './monitoring.service';
import { PrismaService } from '../common/prisma.service';
import { SupabaseService } from '../common/supabase.service';
import { ClockService } from '../common/clock.service';
import { REVIEW_REASON } from './monitoring.constants';

const USER_ID = 'user-cg-0001';
const PATIENT_ID = 'user-pt-0001';
const CAREGIVER_ID = 'cg-0001';
const OTHER_CAREGIVER_ID = 'cg-9999';
const BOOKING_ID = 'book-0001';
const EVENT_ID = 'evt-0001';

// จุดงาน: ห้วยขวาง กรุงเทพฯ (พิกัดชุดเดียวกับที่ prototype ใน Figma ใช้)
const JOB_LAT = 13.7768;
const JOB_LNG = 100.5793;

/** เลื่อนละติจูดไปทางเหนือ ~N เมตร (1 องศาละติจูด ≈ 111,320 ม.) */
function latMetersNorth(meters: number): number {
  return JOB_LAT + meters / 111_320;
}

/**
 * เวลาอ้างอิงของทุกเทส
 * 2026-06-13T02:15:00Z = 09:15 น. ตามเวลาไทย ของวันที่ 13 มิ.ย. 2026
 * งานนัดไว้ 09:00 น. → สายไป 15 นาที ซึ่งยังอยู่ในกรอบ (LATE_VERDICT_MIN = 30)
 */
const NOW = new Date('2026-06-13T02:15:00Z');
const BOOKING_DATE = new Date(Date.UTC(2026, 5, 13)); // คอลัมน์ DATE → เที่ยงคืน UTC
const START_TIME = new Date('1970-01-01T09:00:00Z'); // คอลัมน์ TIME → 09:00 น. ไทย
const SCHEDULED_START = new Date('2026-06-13T02:00:00Z'); // 09:00 ไทย = 02:00Z

/** booking รูปทรงที่ checkInBooking include มา */
function fakeBooking(overrides: Record<string, unknown> = {}) {
  return {
    id: BOOKING_ID,
    patientId: PATIENT_ID,
    caregiverId: CAREGIVER_ID,
    status: 'confirmed',
    bookingDate: BOOKING_DATE,
    startTime: START_TIME,
    durationHours: 3, // จอง 3 ชม. = 180 นาที → ต้องทำงาน ≥ 144 นาที ถึงไม่ติดธง
    locationLat: JOB_LAT,
    locationLng: JOB_LNG,
    reviewReasons: [],
    disputeStatus: 'none',
    payment: { paymentStatus: 'held' },
    caregiver: { userId: USER_ID },
    jobEvents: [], // ยังไม่เคยเช็คอิน
    ...overrides,
  };
}

/**
 * ดึงค่า `data` ของการเรียก prisma ครั้งแรกออกมาแบบมี type
 *
 * ทำไมไม่ใช้ expect.objectContaining ซ้อนกัน: ตัวมันคืน any
 * ทำให้ eslint (no-unsafe-assignment) ร้อง และอ่านยากกว่าด้วย
 */
function createArgData(mock: jest.Mock): Record<string, unknown> {
  const firstCall = mock.mock.calls[0] as [{ data: Record<string, unknown> }];
  return firstCall[0].data;
}

/** แถว job_events ที่ prisma คืนกลับหลัง create */
function fakeEventRow(overrides: Record<string, unknown> = {}) {
  return {
    id: EVENT_ID,
    bookingId: BOOKING_ID,
    eventType: 'check_in',
    source: 'caregiver',
    lat: JOB_LAT,
    lng: JOB_LNG,
    distanceM: 150,
    accuracyM: 18,
    serverTs: NOW,
    deviceTs: null,
    note: null,
    photoUrl: null,
    ...overrides,
  };
}

describe('MonitoringService', () => {
  let service: MonitoringService;
  let prisma: {
    caregiver: { findUnique: jest.Mock };
    booking: { findUnique: jest.Mock; update: jest.Mock };
    jobEvent: { create: jest.Mock; findFirst: jest.Mock };
    $transaction: jest.Mock;
  };

  beforeEach(async () => {
    prisma = {
      caregiver: {
        findUnique: jest.fn().mockResolvedValue({ id: CAREGIVER_ID }),
      },
      booking: { findUnique: jest.fn(), update: jest.fn() },
      jobEvent: { create: jest.fn(), findFirst: jest.fn() },
      // $transaction รับ array ของ promise → คืน array ของผลลัพธ์
      $transaction: jest.fn().mockResolvedValue([fakeEventRow(), {}]),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        MonitoringService,
        { provide: PrismaService, useValue: prisma },
        { provide: SupabaseService, useValue: { getClient: jest.fn() } },
        {
          provide: ClockService,
          useValue: { now: () => NOW, nowMs: () => NOW.getTime() },
        },
      ],
    }).compile();

    service = module.get<MonitoringService>(MonitoringService);
  });

  // ════════════════════════════════════════════════════════════════════
  // A. กฎการติดธง
  // ════════════════════════════════════════════════════════════════════
  describe('evaluate() — กฎรัศมี', () => {
    /** ตัวช่วย: เรียก evaluate ด้วยค่า default ที่ "ปกติทุกอย่าง" แล้ว override เฉพาะที่สนใจ */
    function evaluateWith(overrides: Record<string, unknown> = {}) {
      return service.evaluate({
        eventLat: JOB_LAT,
        eventLng: JOB_LNG,
        accuracyM: 18,
        jobLat: JOB_LAT,
        jobLng: JOB_LNG,
        serverTs: NOW,
        deviceTs: null,
        scheduledStart: SCHEDULED_START,
        ...overrides,
      } as Parameters<MonitoringService['evaluate']>[0]);
    }

    it('อยู่ในรัศมี 200 ม. → ไม่มีธง และ withinWarnRadius = true', () => {
      const result = evaluateWith({ eventLat: latMetersNorth(150) });

      expect(result.distanceM).toBeGreaterThan(120);
      expect(result.distanceM).toBeLessThan(180);
      expect(result.withinWarnRadius).toBe(true);
      expect(result.reviewReasons).toEqual([]);
    });

    it('GPS ดริฟต์ 300 ม. → เตือนใน UI ได้ แต่ต้องไม่ติดธง', () => {
      // นี่คือเคสที่การ์ดยกมาเป็นตัวอย่างหลัก: ดริฟต์ในตึกคอนกรีตเป็นเรื่องปกติ
      const result = evaluateWith({ eventLat: latMetersNorth(300) });

      expect(result.withinWarnRadius).toBe(false); // UI ขึ้นเตือน
      expect(result.reviewReasons).toEqual([]); // แต่ไม่มีธง
    });

    it('ไกล 800 ม. → ติดธง out_of_radius', () => {
      const result = evaluateWith({ eventLat: latMetersNorth(800) });

      expect(result.reviewReasons).toContain(REVIEW_REASON.OUT_OF_RADIUS);
    });

    it('★ ไกล 800 ม. แต่ accuracy 3 กม. (เปิดจากเดสก์ท็อป) → ไม่ติดธงเลย', () => {
      // กฎ 6b: สัญญาณมั่วขนาดนี้ ค่าระยะทางไม่มีความหมาย
      // ถ้าเทสนี้แดง แปลว่าผู้ดูแลที่ใช้คอมพิวเตอร์จะโดนธงกันเกือบหมด
      const result = evaluateWith({
        eventLat: latMetersNorth(800),
        accuracyM: 3000,
      });

      expect(result.gpsAccuracyLow).toBe(true);
      expect(result.distanceM).not.toBeNull(); // ยังเก็บค่าไว้ให้แอดมินดู
      expect(result.reviewReasons).toEqual([]); // แต่ไม่มีธง
    });

    it('booking ไม่มีพิกัดจุดงาน → distanceM = null, ไม่มีธง, jobCoordsMissing = true', () => {
      // booking เก่าทุกใบเป็นแบบนี้ — ห้ามลงโทษผู้ดูแลเพราะข้อมูลเราขาด
      const result = evaluateWith({ jobLat: null, jobLng: null });

      expect(result.distanceM).toBeNull();
      expect(result.jobCoordsMissing).toBe(true);
      expect(result.reviewReasons).toEqual([]);
    });

    it('ผู้ดูแลไม่อนุญาตสิทธิ์ตำแหน่ง → distanceM = null และไม่มีธง', () => {
      const result = evaluateWith({ eventLat: null, eventLng: null });

      expect(result.distanceM).toBeNull();
      expect(result.reviewReasons).toEqual([]);
    });
  });

  describe('evaluate() — กรอบเวลาแบบไม่สมมาตร', () => {
    function evaluateAt(serverTs: Date, deviceTs: Date | null = null) {
      return service.evaluate({
        eventLat: JOB_LAT,
        eventLng: JOB_LNG,
        accuracyM: 18,
        jobLat: JOB_LAT,
        jobLng: JOB_LNG,
        serverTs,
        deviceTs,
        scheduledStart: SCHEDULED_START,
      });
    }

    it('มาก่อนเวลา 5 นาที → ไม่มีธง (มาเช้าไม่ใช่ความผิด)', () => {
      const result = evaluateAt(new Date('2026-06-13T01:55:00Z'));
      expect(result.reviewReasons).toEqual([]);
    });

    it('สายไป 15 นาที → ยังอยู่ในกรอบ ไม่มีธง', () => {
      const result = evaluateAt(new Date('2026-06-13T02:15:00Z'));
      expect(result.reviewReasons).toEqual([]);
    });

    it('สายไป 50 นาที → ติดธง out_of_window', () => {
      const result = evaluateAt(new Date('2026-06-13T02:50:00Z'));
      expect(result.reviewReasons).toContain(REVIEW_REASON.OUT_OF_WINDOW);
    });

    it('มาก่อนเวลา 90 นาที (เกิน EARLY_GRACE_MIN) → ติดธง out_of_window', () => {
      const result = evaluateAt(new Date('2026-06-13T00:30:00Z'));
      expect(result.reviewReasons).toContain(REVIEW_REASON.OUT_OF_WINDOW);
    });

    it('นาฬิกาเครื่องเพี้ยน 2 ชม. → ติดธง clock_anomaly แต่เวลาที่บันทึกยังเป็นของเซิร์ฟเวอร์', () => {
      const result = evaluateAt(NOW, new Date('2026-06-13T04:15:00Z'));
      expect(result.reviewReasons).toContain(REVIEW_REASON.CLOCK_ANOMALY);
    });

    it('นาฬิกาเครื่องต่าง 2 นาที → ปกติ ไม่ติดธง', () => {
      const result = evaluateAt(NOW, new Date('2026-06-13T02:17:00Z'));
      expect(result.reviewReasons).toEqual([]);
    });
  });

  // ════════════════════════════════════════════════════════════════════
  // B. checkInBooking
  // ════════════════════════════════════════════════════════════════════
  describe('checkInBooking() — ด่านตรวจ', () => {
    it('ไม่พบ booking → NotFoundException "ไม่พบงานนี้"', async () => {
      prisma.booking.findUnique.mockResolvedValue(null);

      await expect(
        service.checkInBooking(USER_ID, { bookingId: BOOKING_ID }),
      ).rejects.toThrow(new NotFoundException('ไม่พบงานนี้'));
    });

    it('ไม่ใช่งานของผู้ดูแลคนนี้ → ForbiddenException "งานนี้ไม่ใช่ของคุณ"', async () => {
      prisma.booking.findUnique.mockResolvedValue(
        fakeBooking({ caregiverId: OTHER_CAREGIVER_ID }),
      );

      await expect(
        service.checkInBooking(USER_ID, { bookingId: BOOKING_ID }),
      ).rejects.toThrow(new ForbiddenException('งานนี้ไม่ใช่ของคุณ'));
    });

    it('สถานะยังไม่ confirmed → "งานนี้ยังไม่พร้อมเริ่ม"', async () => {
      prisma.booking.findUnique.mockResolvedValue(
        fakeBooking({ status: 'accepted' }),
      );

      await expect(
        service.checkInBooking(USER_ID, { bookingId: BOOKING_ID }),
      ).rejects.toThrow(new BadRequestException('งานนี้ยังไม่พร้อมเริ่ม'));
    });

    it('ยังไม่ได้จ่ายเงินเข้า escrow → "ยังไม่ได้รับการชำระเงิน"', async () => {
      prisma.booking.findUnique.mockResolvedValue(
        fakeBooking({ payment: { paymentStatus: 'pending' } }),
      );

      await expect(
        service.checkInBooking(USER_ID, { bookingId: BOOKING_ID }),
      ).rejects.toThrow(new BadRequestException('ยังไม่ได้รับการชำระเงิน'));
    });

    it('ยังไม่ถึงวันทำงาน (นับตามเวลาไทย) → "ยังไม่ถึงวันทำงาน"', async () => {
      prisma.booking.findUnique.mockResolvedValue(
        fakeBooking({ bookingDate: new Date(Date.UTC(2026, 5, 20)) }),
      );

      await expect(
        service.checkInBooking(USER_ID, { bookingId: BOOKING_ID }),
      ).rejects.toThrow(new BadRequestException('ยังไม่ถึงวันทำงาน'));
    });
  });

  describe('checkInBooking() — เส้นทางสำเร็จ', () => {
    it('เช็คอินปกติ → สร้าง 1 แถว + เปลี่ยนสถานะเป็น in_progress', async () => {
      prisma.booking.findUnique.mockResolvedValue(fakeBooking());

      const result = await service.checkInBooking(USER_ID, {
        bookingId: BOOKING_ID,
        lat: latMetersNorth(150),
        lng: JOB_LNG,
        accuracyM: 18,
      });

      // แถวหลักฐานถูกสร้างด้วยเวลาของเซิร์ฟเวอร์ ไม่ใช่ของเครื่อง client
      expect(createArgData(prisma.jobEvent.create)).toMatchObject({
        eventType: 'check_in',
        source: 'caregiver',
        serverTs: NOW,
      });

      // สถานะงานเปลี่ยน
      expect(createArgData(prisma.booking.update)).toMatchObject({
        status: 'in_progress',
      });

      // ทั้งสองอย่างอยู่ใน transaction เดียวกัน
      expect(prisma.$transaction).toHaveBeenCalledTimes(1);
      expect(result.alreadyCheckedIn).toBe(false);
    });

    it('★ อยู่ห่าง 800 ม. → เช็คอิน "สำเร็จ" แต่ติดธง (GPS ห้ามบล็อกเด็ดขาด)', async () => {
      prisma.booking.findUnique.mockResolvedValue(fakeBooking());

      const result = await service.checkInBooking(USER_ID, {
        bookingId: BOOKING_ID,
        lat: latMetersNorth(800),
        lng: JOB_LNG,
        accuracyM: 18,
      });

      expect(result).toBeDefined(); // ไม่ throw
      expect(result.reviewReasons).toContain(REVIEW_REASON.OUT_OF_RADIUS);
      // ธงต้องถูกเขียนลง bookings.review_reasons ด้วย ไม่ใช่แค่คืนกลับไปเฉย ๆ
      expect(createArgData(prisma.booking.update)).toMatchObject({
        reviewReasons: { set: [REVIEW_REASON.OUT_OF_RADIUS] },
      });
    });

    it('ไม่ให้สิทธิ์ตำแหน่ง (ไม่ส่ง lat/lng) → ยังเช็คอินได้ ไม่มีธง', async () => {
      prisma.booking.findUnique.mockResolvedValue(fakeBooking());

      const result = await service.checkInBooking(USER_ID, {
        bookingId: BOOKING_ID,
      });

      expect(result).toBeDefined();
      expect(result.reviewReasons).toEqual([]);
    });
  });

  describe('checkInBooking() — กดซ้ำต้องไม่พัง (AC ข้อ 8)', () => {
    it('มีแถว check_in อยู่แล้ว → คืนแถวเดิม ไม่สร้างใหม่ ไม่ throw', async () => {
      prisma.booking.findUnique.mockResolvedValue(
        fakeBooking({
          status: 'in_progress', // สถานะเปลี่ยนไปแล้วจากการเช็คอินครั้งแรก
          jobEvents: [fakeEventRow()],
        }),
      );

      const result = await service.checkInBooking(USER_ID, {
        bookingId: BOOKING_ID,
      });

      expect(result.id).toBe(EVENT_ID);
      expect(result.alreadyCheckedIn).toBe(true);
      // ★ สำคัญ: ต้องไม่มีการเขียนอะไรเพิ่มเลย
      expect(prisma.$transaction).not.toHaveBeenCalled();
      expect(prisma.jobEvent.create).not.toHaveBeenCalled();
    });
  });
});
