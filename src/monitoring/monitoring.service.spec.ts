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
import { ConfigService } from '@nestjs/config';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { MonitoringService } from './monitoring.service';
import { PrismaService } from '../common/prisma.service';
import { SupabaseService } from '../common/supabase.service';
import { ClockService } from '../common/clock.service';
import { BOOKING_STATUS, REVIEW_REASON, VERDICT } from './monitoring.constants';

const USER_ID = 'user-cg-0001';
const PATIENT_ID = 'user-pt-0001';
const CAREGIVER_ID = 'cg-0001';
const OTHER_CAREGIVER_ID = 'cg-9999';
const BOOKING_ID = 'book-0001';
const EVENT_ID = 'evt-0001';

// จุดงาน: ห้วยขวาง กรุงเทพฯ (พิกัดชุดเดียวกับที่ prototype ใน Figma ใช้)
const JOB_LAT = 13.7768;
const JOB_LNG = 100.5793;

/** โปรเจกต์ Supabase สมมติ — ใช้ตรวจว่า URL ของไฟล์แนบมาจากบ้านเราจริง */
const SUPABASE_URL = 'https://abcdefgh.supabase.co';

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
          // ใช้ตรวจ host ของไฟล์แนบ (PYG-358 STEP 2)
          provide: ConfigService,
          useValue: { get: () => SUPABASE_URL },
        },
        { provide: EventEmitter2, useValue: { emit: jest.fn() } },
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

  // ══════════════════════════════════════════════════════════════════
  // C. computeVerdict — กฎตัดสินที่เงินทั้งระบบพึ่งพา (PYG-358)
  // ══════════════════════════════════════════════════════════════════
  describe('computeVerdict() — ครบทุกคอมบิเนชัน', () => {
    const CG = 'caregiver';
    const SYS = 'system';

    it('ไม่มีเช็คอิน → incomplete', () => {
      expect(service.computeVerdict([], false, CG, 'none')).toBe(
        VERDICT.INCOMPLETE,
      );
    });

    it('ไม่มีเช็คเอาท์ → incomplete', () => {
      expect(service.computeVerdict([], true, null, 'none')).toBe(
        VERDICT.INCOMPLETE,
      );
    });

    it('ครบทุกอย่าง ไม่มีธง ไม่มีข้อพิพาท → valid', () => {
      expect(service.computeVerdict([], true, CG, 'none')).toBe(VERDICT.VALID);
    });

    it('มีธงแม้แต่ตัวเดียว → needs_review', () => {
      expect(
        service.computeVerdict(
          [REVIEW_REASON.SHORT_DURATION],
          true,
          CG,
          'none',
        ),
      ).toBe(VERDICT.NEEDS_REVIEW);
    });

    it('★ ระบบปิดงานให้เอง (source=system) → needs_review เสมอ แม้ไม่มีธงเลย', () => {
      // นี่คือกันไม่ให้งานที่ผู้ดูแลลืมปิด ถูกปล่อยเงินอัตโนมัติ
      expect(service.computeVerdict([], true, SYS, 'none')).toBe(
        VERDICT.NEEDS_REVIEW,
      );
    });

    it('มีข้อพิพาทค้างอยู่ → needs_review แม้ไม่มีธงและผู้ดูแลปิดเอง', () => {
      expect(service.computeVerdict([], true, CG, 'open')).toBe(
        VERDICT.NEEDS_REVIEW,
      );
    });

    it('มีทั้งธง ทั้ง system ทั้งข้อพิพาท → needs_review', () => {
      expect(
        service.computeVerdict([REVIEW_REASON.NO_CHECKOUT], true, SYS, 'open'),
      ).toBe(VERDICT.NEEDS_REVIEW);
    });
  });

  // ══════════════════════════════════════════════════════════════════
  // D. checkOutBooking
  // ══════════════════════════════════════════════════════════════════
  describe('checkOutBooking()', () => {
    /** แถวเช็คอินที่เกิดขึ้นเมื่อ N นาทีก่อน (ตามเวลาเซิร์ฟเวอร์) */
    function checkInRow(minutesAgo: number) {
      return fakeEventRow({
        id: 'evt-in',
        eventType: 'check_in',
        serverTs: new Date(NOW.getTime() - minutesAgo * 60000),
      });
    }

    beforeEach(() => {
      prisma.$transaction.mockResolvedValue([
        fakeEventRow({ id: 'evt-out', eventType: 'check_out' }),
        {},
      ]);
    });

    it('ยังไม่ได้เช็คอิน → "ยังไม่ได้เช็คอิน จึงเช็คเอาท์ไม่ได้"', async () => {
      prisma.booking.findUnique.mockResolvedValue(
        fakeBooking({ jobEvents: [] }),
      );

      await expect(
        service.checkOutBooking(USER_ID, { bookingId: BOOKING_ID }),
      ).rejects.toThrow(
        new BadRequestException('ยังไม่ได้เช็คอิน จึงเช็คเอาท์ไม่ได้'),
      );
    });

    it('ไม่ใช่งานของผู้ดูแลคนนี้ → "งานนี้ไม่ใช่ของคุณ"', async () => {
      prisma.booking.findUnique.mockResolvedValue(
        fakeBooking({ caregiverId: OTHER_CAREGIVER_ID }),
      );

      await expect(
        service.checkOutBooking(USER_ID, { bookingId: BOOKING_ID }),
      ).rejects.toThrow(new ForbiddenException('งานนี้ไม่ใช่ของคุณ'));
    });

    it('ทำงานครบเวลา (170 จาก 180 นาที) → ไม่มีธง + awaiting_release', async () => {
      prisma.booking.findUnique.mockResolvedValue(
        fakeBooking({ status: 'in_progress', jobEvents: [checkInRow(170)] }),
      );

      await service.checkOutBooking(USER_ID, {
        bookingId: BOOKING_ID,
        lat: JOB_LAT,
        lng: JOB_LNG,
      });

      expect(createArgData(prisma.booking.update)).toMatchObject({
        status: BOOKING_STATUS.AWAITING_RELEASE,
        reviewReasons: { set: [] },
      });
    });

    it('ทำงาน 70% ของเวลาที่จอง → short_duration + needs_review', async () => {
      // จอง 180 นาที ทำจริง 126 นาที = 70% ซึ่งต่ำกว่าเกณฑ์ 80%
      prisma.booking.findUnique.mockResolvedValue(
        fakeBooking({ status: 'in_progress', jobEvents: [checkInRow(126)] }),
      );

      await service.checkOutBooking(USER_ID, {
        bookingId: BOOKING_ID,
        lat: JOB_LAT,
        lng: JOB_LNG,
      });

      expect(createArgData(prisma.booking.update)).toMatchObject({
        status: BOOKING_STATUS.NEEDS_REVIEW,
        reviewReasons: { set: [REVIEW_REASON.SHORT_DURATION] },
      });
    });

    it('★ ระยะเวลาคำนวณจาก server_ts เท่านั้น — device_ts ที่โกหกไม่มีผล', async () => {
      // เช็คอินจริง 30 นาทีที่แล้ว (สั้นกว่าเกณฑ์แน่นอน)
      // แต่เครื่อง client อ้างว่าตอนนี้คือ 5 ชม. ข้างหน้า เพื่อให้ดูเหมือนทำงานครบ
      prisma.booking.findUnique.mockResolvedValue(
        fakeBooking({ status: 'in_progress', jobEvents: [checkInRow(30)] }),
      );

      await service.checkOutBooking(USER_ID, {
        bookingId: BOOKING_ID,
        deviceTs: new Date(NOW.getTime() + 5 * 60 * 60 * 1000).toISOString(),
      });

      // ยังติดธงอยู่ดี = การโกหกนาฬิกาไม่ช่วยอะไร
      expect(createArgData(prisma.booking.update)).toMatchObject({
        reviewReasons: { set: [REVIEW_REASON.SHORT_DURATION] },
      });
    });

    it('★ ธงจากตอนเช็คอินต้องยังอยู่ ไม่ถูกเขียนทับ', async () => {
      prisma.booking.findUnique.mockResolvedValue(
        fakeBooking({
          status: 'in_progress',
          reviewReasons: [REVIEW_REASON.OUT_OF_WINDOW], // ติดมาตั้งแต่เช็คอิน
          jobEvents: [checkInRow(170)],
        }),
      );

      await service.checkOutBooking(USER_ID, {
        bookingId: BOOKING_ID,
        lat: JOB_LAT,
        lng: JOB_LNG,
      });

      const data = createArgData(prisma.booking.update);
      expect(data.reviewReasons).toEqual({
        set: [REVIEW_REASON.OUT_OF_WINDOW],
      });
      expect(data.status).toBe(BOOKING_STATUS.NEEDS_REVIEW);
    });

    it('ปิดงานซ้ำ → คืนแถวเดิม ไม่เขียนอะไรเพิ่ม', async () => {
      prisma.booking.findUnique.mockResolvedValue(
        fakeBooking({
          status: 'awaiting_release',
          jobEvents: [
            checkInRow(170),
            fakeEventRow({ id: 'evt-out', eventType: 'check_out' }),
          ],
        }),
      );

      const result = await service.checkOutBooking(USER_ID, {
        bookingId: BOOKING_ID,
      });

      expect(result.id).toBe('evt-out');
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });
  });

  // ══════════════════════════════════════════════════════════════════
  // E. ตรวจไฟล์แนบ (PYG-358 STEP 2)
  // ══════════════════════════════════════════════════════════════════
  describe('checkOutBooking() — ไฟล์แนบ', () => {
    beforeEach(() => {
      prisma.booking.findUnique.mockResolvedValue(
        fakeBooking({
          status: 'in_progress',
          jobEvents: [
            fakeEventRow({
              id: 'evt-in',
              eventType: 'check_in',
              serverTs: new Date(NOW.getTime() - 170 * 60000),
            }),
          ],
        }),
      );
      prisma.$transaction.mockResolvedValue([
        fakeEventRow({ id: 'evt-out', eventType: 'check_out' }),
        {},
      ]);
    });

    /** เรียก checkOut พร้อมแนบไฟล์ */
    function checkOutWithPhoto(photoUrl: string) {
      return service.checkOutBooking(USER_ID, {
        bookingId: BOOKING_ID,
        photoUrl,
      });
    }

    it('★ URL จากโดเมนอื่น → ปฏิเสธ "ไฟล์แนบไม่ถูกต้อง"', async () => {
      await expect(checkOutWithPhoto('https://evil.com/x.jpg')).rejects.toThrow(
        new BadRequestException('ไฟล์แนบไม่ถูกต้อง'),
      );
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('★ URL บ้านเราแต่เป็นของ booking อื่น → ปฏิเสธ', async () => {
      // host ถูก bucket ถูก แต่โฟลเดอร์เป็นของงานอื่น
      await expect(
        checkOutWithPhoto(
          `${SUPABASE_URL}/storage/v1/object/sign/job-evidence/book-9999/check-out-1.jpg`,
        ),
      ).rejects.toThrow(new BadRequestException('ไฟล์แนบไม่ถูกต้อง'));
    });

    it('URL บ้านเราแต่ผิด bucket → ปฏิเสธ', async () => {
      await expect(
        checkOutWithPhoto(
          `${SUPABASE_URL}/storage/v1/object/sign/kyc-documents/${BOOKING_ID}/x.jpg`,
        ),
      ).rejects.toThrow(new BadRequestException('ไฟล์แนบไม่ถูกต้อง'));
    });

    it('path ที่มี ../ → ปฏิเสธ (กันหลุดออกนอกโฟลเดอร์)', async () => {
      await expect(
        checkOutWithPhoto(`${BOOKING_ID}/../book-9999/x.jpg`),
      ).rejects.toThrow(new BadRequestException('ไฟล์แนบไม่ถูกต้อง'));
    });

    it('URL ที่ถูกต้อง → ผ่าน และเก็บเป็น "path" ไม่ใช่ URL', async () => {
      await checkOutWithPhoto(
        `${SUPABASE_URL}/storage/v1/object/sign/job-evidence/${BOOKING_ID}/check-out-1.jpg`,
      );

      // ★ สิ่งที่ลงฐานข้อมูลต้องเป็น path เปล่า ๆ เพื่อให้ sign ใหม่ได้ทุกครั้งที่อ่าน
      expect(createArgData(prisma.jobEvent.create)).toMatchObject({
        photoUrl: `${BOOKING_ID}/check-out-1.jpg`,
      });
    });

    it('ส่ง path เปล่าของ booking ตัวเอง → ผ่าน', async () => {
      await checkOutWithPhoto(`${BOOKING_ID}/check-out-2.jpg`);

      expect(createArgData(prisma.jobEvent.create)).toMatchObject({
        photoUrl: `${BOOKING_ID}/check-out-2.jpg`,
      });
    });

    it('ไม่แนบรูป → ผ่าน และเก็บ null', async () => {
      await service.checkOutBooking(USER_ID, { bookingId: BOOKING_ID });

      expect(createArgData(prisma.jobEvent.create)).toMatchObject({
        photoUrl: null,
      });
    });
  });

  // ══════════════════════════════════════════════════════════════════
  // F. proofOfWork
  // ══════════════════════════════════════════════════════════════════
  describe('proofOfWork()', () => {
    const ADMIN_ROLE = 3;
    const CAREGIVER_ROLE = 2;

    function bookingWithBothEvents(overrides: Record<string, unknown> = {}) {
      return fakeBooking({
        status: 'awaiting_release',
        jobEvents: [
          fakeEventRow({
            id: 'evt-in',
            eventType: 'check_in',
            distanceM: 150,
            serverTs: new Date(NOW.getTime() - 170 * 60000),
          }),
          fakeEventRow({
            id: 'evt-out',
            eventType: 'check_out',
            distanceM: 180,
            serverTs: NOW,
          }),
        ],
        ...overrides,
      });
    }

    it('งานปกติ → verdict valid, ระยะทางเป็นตัวเลขดิบ, actualMinutes ถูกต้อง', async () => {
      prisma.booking.findUnique.mockResolvedValue(bookingWithBothEvents());

      const result = await service.proofOfWork(
        USER_ID,
        CAREGIVER_ROLE,
        BOOKING_ID,
      );

      expect(result.verdict).toBe(VERDICT.VALID);
      expect(result.actualMinutes).toBe(170);
      expect(result.bookedMinutes).toBe(180);
      expect(result.distanceInM).toBe(150); // ค่าดิบ ไม่ใช่ boolean
      expect(result.distanceOutM).toBe(180);
      expect(result.durationOk).toBe(true);
      expect(result.noCheckout).toBe(false);
      expect(result.disputed).toBe(false);
    });

    it('ยังไม่ปิดงาน → verdict incomplete และ actualMinutes เป็น null', async () => {
      prisma.booking.findUnique.mockResolvedValue(
        fakeBooking({
          status: 'in_progress',
          jobEvents: [fakeEventRow({ id: 'evt-in', eventType: 'check_in' })],
        }),
      );

      const result = await service.proofOfWork(
        USER_ID,
        CAREGIVER_ROLE,
        BOOKING_ID,
      );

      expect(result.verdict).toBe(VERDICT.INCOMPLETE);
      expect(result.actualMinutes).toBeUndefined();
      expect(result.noCheckout).toBe(true);
    });

    it('★ ระบบปิดให้เอง → ไม่คำนวณระยะเวลา + noCheckout + needs_review', async () => {
      prisma.booking.findUnique.mockResolvedValue(
        bookingWithBothEvents({
          reviewReasons: [REVIEW_REASON.NO_CHECKOUT],
          jobEvents: [
            fakeEventRow({
              id: 'evt-in',
              eventType: 'check_in',
              serverTs: new Date(NOW.getTime() - 170 * 60000),
            }),
            fakeEventRow({
              id: 'evt-out',
              eventType: 'check_out',
              source: 'system',
              distanceM: null,
              serverTs: NOW,
            }),
          ],
        }),
      );

      const result = await service.proofOfWork(
        USER_ID,
        CAREGIVER_ROLE,
        BOOKING_ID,
      );

      expect(result.actualMinutes).toBeUndefined(); // ไม่มีใครรู้ว่าออกจริงตอนไหน
      expect(result.noCheckout).toBe(true);
      expect(result.verdict).toBe(VERDICT.NEEDS_REVIEW);
    });

    it('มีข้อพิพาท → disputed = true และ verdict needs_review', async () => {
      prisma.booking.findUnique.mockResolvedValue(
        bookingWithBothEvents({ disputeStatus: 'open' }),
      );

      const result = await service.proofOfWork(
        USER_ID,
        CAREGIVER_ROLE,
        BOOKING_ID,
      );

      expect(result.disputed).toBe(true);
      expect(result.verdict).toBe(VERDICT.NEEDS_REVIEW);
    });

    it('booking ไม่มีพิกัด → jobCoordsMissing = true แต่ verdict ยัง valid', async () => {
      prisma.booking.findUnique.mockResolvedValue(
        bookingWithBothEvents({ locationLat: null, locationLng: null }),
      );

      const result = await service.proofOfWork(
        USER_ID,
        CAREGIVER_ROLE,
        BOOKING_ID,
      );

      expect(result.jobCoordsMissing).toBe(true);
      expect(result.verdict).toBe(VERDICT.VALID); // ข้อมูลเราขาด ไม่ใช่ความผิดผู้ดูแล
    });

    it('คนนอกที่ไม่ใช่คู่กรณี → ForbiddenException', async () => {
      prisma.booking.findUnique.mockResolvedValue(bookingWithBothEvents());

      await expect(
        service.proofOfWork('user-stranger', CAREGIVER_ROLE, BOOKING_ID),
      ).rejects.toThrow(ForbiddenException);
    });

    it('แอดมินดูได้ทุกงาน แม้ไม่ใช่คู่กรณี', async () => {
      prisma.booking.findUnique.mockResolvedValue(bookingWithBothEvents());

      const result = await service.proofOfWork(
        'user-admin',
        ADMIN_ROLE,
        BOOKING_ID,
      );

      expect(result.verdict).toBe(VERDICT.VALID);
    });
  });
});
