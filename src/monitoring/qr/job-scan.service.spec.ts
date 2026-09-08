/**
 * Unit tests สำหรับ JobScanService (PYG-435 · การ์ดแม่ PYG-433)
 *
 * ไล่ตาม AC ของการ์ดทีละข้อ:
 *   A. สแกนแรก = check-in            → SUCCESS + action CHECK_IN
 *   B. สแกนสอง = check-out           → SUCCESS + action CHECK_OUT
 *   C. caregiver ผิดคน               → WRONG_CAREGIVER
 *   D. หมดช่วงเวลา                   → OUT_OF_WINDOW
 *   E. สแกนซ้ำครั้งที่สาม             → ALREADY_COMPLETED
 *   F. ผิดลำดับ                      → WRONG_SEQUENCE
 *   G. log ครบ                       → มีแถวใน job_scan_events ทุกกรณี
 *   + Edge: สแกนรัว / นอกช่วงเวลา / caregiver ถูกเปลี่ยนกลางคัน / งานถูกยกเลิก
 *
 * mock ทุกอย่างที่แตะดีบีและเวลา → ไม่มีการต่อ DB จริง
 *
 * ★ ธีมที่ทดสอบซ้ำ ๆ ตลอดไฟล์: การสแกนที่ "ไม่ผ่าน" ต้องไม่ throw
 *   แต่ต้องคืน ok=false + รหัสเหตุผล และต้องถูกบันทึกไว้เสมอ
 */
import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { createHash } from 'crypto';
import { PrismaService } from '../../common/prisma.service';
import { ClockService } from '../../common/clock.service';
import { MonitoringService } from '../monitoring.service';
import { JobQrService } from './job-qr.service';
import { JobScanService } from './job-scan.service';
import { ScanAction, ScanResult } from './entities/scan-result.enum';
import {
  JobSessionStatus,
  toJobSessionStatus,
} from './entities/job-session-status.enum';
import {
  JOB_SESSION_STATUS,
  SCAN_ACTION,
  SCAN_RESULT,
  SCAN_RESULT_MESSAGE,
} from './qr.constants';

const USER_ID = 'user-cg-0001';
const CAREGIVER_ID = 'cg-0001';
const OTHER_CAREGIVER_ID = 'cg-9999';
const BOOKING_ID = '11111111-1111-4111-8111-111111111111';
const SESSION_ID = '22222222-2222-4222-8222-222222222222';
const TOKEN = 'a-token-that-looks-like-the-real-thing';

/** sha256 ของ TOKEN — คำนวณด้วยสูตรเดียวกับที่ service ใช้ */
const TOKEN_HASH = createHash('sha256').update(TOKEN, 'utf8').digest('hex');

/**
 * งานตัวอย่าง: 13 มิ.ย. 2026 — ช่วงที่ QR ใช้ได้คือ 01:00Z ถึง 08:00Z
 * (ชุดตัวเลขเดียวกับ job-qr.service.spec.ts เพื่อให้เทียบกันได้ตรง ๆ)
 */
const VALID_FROM = new Date('2026-06-13T01:00:00Z');
const VALID_UNTIL = new Date('2026-06-13T08:00:00Z');
/** เวลาปัจจุบันของเทสส่วนใหญ่ — อยู่กลางช่วงพอดี */
const NOW = new Date('2026-06-13T03:00:00Z');

/** แถว job_sessions ที่ scanJobQr() select มา */
function fakeSession(overrides: Record<string, unknown> = {}) {
  return {
    id: SESSION_ID,
    bookingId: BOOKING_ID,
    status: JOB_SESSION_STATUS.PENDING,
    validFrom: VALID_FROM,
    validUntil: VALID_UNTIL,
    checkedInAt: null,
    booking: { status: 'confirmed', caregiverId: CAREGIVER_ID },
    ...overrides,
  };
}

/** ก้อนที่ MonitoringService คืนกลับมาหลังเช็คอิน/เช็คเอาท์สำเร็จ */
function fakeJobEvent(overrides: Record<string, unknown> = {}) {
  return {
    id: 'evt-0001',
    bookingId: BOOKING_ID,
    eventType: 'check_in',
    source: 'caregiver',
    serverTs: NOW,
    gpsAccuracyLow: false,
    jobCoordsMissing: false,
    reviewReasons: [],
    alreadyCheckedIn: false,
    ...overrides,
  };
}

describe('JobScanService (PYG-435)', () => {
  let service: JobScanService;
  let prisma: {
    caregiver: { findUnique: jest.Mock };
    jobSession: { findUnique: jest.Mock; updateMany: jest.Mock };
    jobEvent: { findFirst: jest.Mock };
    jobScanEvent: { create: jest.Mock };
  };
  let monitoring: { checkInBooking: jest.Mock; checkOutBooking: jest.Mock };

  beforeEach(async () => {
    prisma = {
      caregiver: {
        findUnique: jest.fn().mockResolvedValue({ id: CAREGIVER_ID }),
      },
      jobSession: {
        findUnique: jest.fn().mockResolvedValue(fakeSession()),
        // count: 1 = ชนะการแข่ง (เคสปกติ)
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      jobEvent: { findFirst: jest.fn().mockResolvedValue({ id: 'evt-in' }) },
      jobScanEvent: { create: jest.fn().mockResolvedValue({}) },
    };

    monitoring = {
      checkInBooking: jest.fn().mockResolvedValue(fakeJobEvent()),
      checkOutBooking: jest
        .fn()
        .mockResolvedValue(fakeJobEvent({ eventType: 'check_out' })),
    };

    const moduleRef: TestingModule = await Test.createTestingModule({
      providers: [
        JobScanService,
        { provide: PrismaService, useValue: prisma },
        { provide: ClockService, useValue: { now: () => NOW } },
        // ใช้ตัวจริงของ hashToken เพื่อให้เทสพิสูจน์ "สูตรเดียวกัน" ได้จริง ๆ
        {
          provide: JobQrService,
          useValue: {
            hashToken: (t: string) =>
              createHash('sha256').update(t, 'utf8').digest('hex'),
          },
        },
        { provide: MonitoringService, useValue: monitoring },
      ],
    }).compile();

    service = moduleRef.get<JobScanService>(JobScanService);
  });

  /** ค่า data ของแถว job_scan_events ที่เพิ่งถูกเขียน */
  function auditRow(): Record<string, unknown> {
    const call = prisma.jobScanEvent.create.mock.calls[0] as [
      { data: Record<string, unknown> },
    ];
    return call[0].data;
  }

  // ════════════════════════════════════════════════════════════════════
  // A. เส้นทางสำเร็จ — สแกนแรก = เช็คอิน, สแกนสอง = เช็คเอาท์
  // ════════════════════════════════════════════════════════════════════
  describe('เส้นทางสำเร็จ', () => {
    it('สแกนครั้งแรก (PENDING) → เช็คอิน', async () => {
      const result = await service.scanJobQr(USER_ID, { token: TOKEN });

      expect(result.ok).toBe(true);
      expect(result.result).toBe(ScanResult.SUCCESS);
      expect(result.action).toBe(ScanAction.CHECK_IN);
      expect(result.bookingId).toBe(BOOKING_ID);
      expect(result.sessionStatus).toBe(JOB_SESSION_STATUS.CHECKED_IN);
      expect(monitoring.checkInBooking).toHaveBeenCalledTimes(1);
      expect(monitoring.checkOutBooking).not.toHaveBeenCalled();
    });

    it('สแกนครั้งที่สอง (CHECKED_IN) → เช็คเอาท์', async () => {
      prisma.jobSession.findUnique.mockResolvedValue(
        fakeSession({
          status: JOB_SESSION_STATUS.CHECKED_IN,
          // เช็คอินไปนานแล้ว จึงไม่ติดด่าน "สแกนถี่เกินไป"
          checkedInAt: new Date(NOW.getTime() - 3 * 60 * 60 * 1000),
        }),
      );

      const result = await service.scanJobQr(USER_ID, { token: TOKEN });

      expect(result.ok).toBe(true);
      expect(result.action).toBe(ScanAction.CHECK_OUT);
      expect(result.sessionStatus).toBe(JOB_SESSION_STATUS.CHECKED_OUT);
      expect(monitoring.checkOutBooking).toHaveBeenCalledTimes(1);
      expect(monitoring.checkInBooking).not.toHaveBeenCalled();
    });

    it('ผู้เรียก "ไม่ได้เลือก" action — ระบบตัดสินจากสถานะของ QR เท่านั้น', async () => {
      // input ไม่มีฟิลด์ action ให้ส่งอยู่แล้ว เทสนี้ยืนยันว่าสถานะเป็นตัวชี้ขาดจริง
      const first = await service.scanJobQr(USER_ID, { token: TOKEN });
      expect(first.action).toBe(ScanAction.CHECK_IN);

      prisma.jobSession.findUnique.mockResolvedValue(
        fakeSession({
          status: JOB_SESSION_STATUS.CHECKED_IN,
          checkedInAt: new Date(NOW.getTime() - 3 * 60 * 60 * 1000),
        }),
      );
      const second = await service.scanJobQr(USER_ID, { token: TOKEN });
      expect(second.action).toBe(ScanAction.CHECK_OUT);
    });

    it('ส่งต่อพิกัด/บันทึก/รูป ให้ระบบเช็คอิน-เช็คเอาท์เดิมครบ', async () => {
      await service.scanJobQr(USER_ID, {
        token: TOKEN,
        lat: 13.75,
        lng: 100.5,
        accuracyM: 25,
        deviceTs: '2026-06-13T03:00:00.000Z',
      });

      expect(monitoring.checkInBooking).toHaveBeenCalledWith(
        USER_ID,
        expect.objectContaining({
          bookingId: BOOKING_ID,
          lat: 13.75,
          lng: 100.5,
          accuracyM: 25,
        }),
        { viaScan: true },
      );
    });

    it('★ ต้องส่ง viaScan: true เสมอ ไม่งั้นประตูของ PYG-435 จะปิดใส่ตัวเอง', async () => {
      await service.scanJobQr(USER_ID, { token: TOKEN });

      const call = monitoring.checkInBooking.mock.calls[0] as [
        string,
        Record<string, unknown>,
        { viaScan?: boolean },
      ];
      expect(call[2].viaScan).toBe(true);
    });

    it('เช็คเอาท์ส่ง note/photoUrl ต่อไปให้ระบบเดิม', async () => {
      prisma.jobSession.findUnique.mockResolvedValue(
        fakeSession({
          status: JOB_SESSION_STATUS.CHECKED_IN,
          checkedInAt: new Date(NOW.getTime() - 3 * 60 * 60 * 1000),
        }),
      );

      await service.scanJobQr(USER_ID, {
        token: TOKEN,
        note: 'ผู้สูงอายุทานข้าวครบ 3 มื้อ',
        photoUrl: `${BOOKING_ID}/check-out.jpg`,
      });

      expect(monitoring.checkOutBooking).toHaveBeenCalledWith(
        USER_ID,
        expect.objectContaining({
          note: 'ผู้สูงอายุทานข้าวครบ 3 มื้อ',
          photoUrl: `${BOOKING_ID}/check-out.jpg`,
        }),
        { viaScan: true },
      );
    });
  });

  // ════════════════════════════════════════════════════════════════════
  // B. ด่านตรวจ — ทุกข้อต้อง "ไม่ throw" แต่คืนรหัสเหตุผล
  // ════════════════════════════════════════════════════════════════════
  describe('ด่านตรวจ (ปฏิเสธโดยไม่ throw)', () => {
    it('บัญชีไม่มีโปรไฟล์ผู้ดูแล → NOT_A_CAREGIVER', async () => {
      prisma.caregiver.findUnique.mockResolvedValue(null);

      const result = await service.scanJobQr(USER_ID, { token: TOKEN });

      expect(result.ok).toBe(false);
      expect(result.result).toBe(ScanResult.NOT_A_CAREGIVER);
      expect(result.action).toBe(ScanAction.NONE);
      // ยังไม่ทันไปแตะ session ด้วยซ้ำ
      expect(prisma.jobSession.findUnique).not.toHaveBeenCalled();
    });

    it('token ไม่ตรงกับ QR ใบไหน → TOKEN_NOT_FOUND และไม่บอกอะไรเพิ่ม', async () => {
      prisma.jobSession.findUnique.mockResolvedValue(null);

      const result = await service.scanJobQr(USER_ID, { token: 'ของปลอม' });

      expect(result.ok).toBe(false);
      expect(result.result).toBe(ScanResult.TOKEN_NOT_FOUND);
      // ★ ต้องไม่หลุด bookingId ออกไป เพราะเรายังไม่รู้ว่าเป็นงานใบไหนจริง ๆ
      expect(result.bookingId).toBeUndefined();
      expect(result.sessionStatus).toBeUndefined();
    });

    it('ผู้ดูแลผิดคน → WRONG_CAREGIVER และงานไม่ขยับ', async () => {
      prisma.jobSession.findUnique.mockResolvedValue(
        fakeSession({
          booking: { status: 'confirmed', caregiverId: OTHER_CAREGIVER_ID },
        }),
      );

      const result = await service.scanJobQr(USER_ID, { token: TOKEN });

      expect(result.result).toBe(ScanResult.WRONG_CAREGIVER);
      expect(monitoring.checkInBooking).not.toHaveBeenCalled();
      expect(prisma.jobSession.updateMany).not.toHaveBeenCalled();
    });

    it('ยังไม่มีใครรับงาน (caregiverId = null) → WRONG_CAREGIVER', async () => {
      prisma.jobSession.findUnique.mockResolvedValue(
        fakeSession({ booking: { status: 'confirmed', caregiverId: null } }),
      );

      const result = await service.scanJobQr(USER_ID, { token: TOKEN });

      expect(result.result).toBe(ScanResult.WRONG_CAREGIVER);
    });

    it('★ ผู้ดูแลผิดคน ต้องไม่ได้รู้ว่างานนั้นถูกยกเลิกไปแล้วหรือยัง', async () => {
      // งานถูกยกเลิก + ผู้ดูแลผิดคน → ต้องได้ WRONG_CAREGIVER ไม่ใช่ BOOKING_INACTIVE
      // ถ้าลำดับด่านสลับ คนที่ถือ QR ของคนอื่นจะเดาสถานะงานคนอื่นได้
      prisma.jobSession.findUnique.mockResolvedValue(
        fakeSession({
          booking: { status: 'cancelled', caregiverId: OTHER_CAREGIVER_ID },
        }),
      );

      const result = await service.scanJobQr(USER_ID, { token: TOKEN });

      expect(result.result).toBe(ScanResult.WRONG_CAREGIVER);
    });

    it.each(['cancelled', 'rejected'])(
      'งานสถานะ %s → BOOKING_INACTIVE',
      async (status) => {
        prisma.jobSession.findUnique.mockResolvedValue(
          fakeSession({ booking: { status, caregiverId: CAREGIVER_ID } }),
        );

        const result = await service.scanJobQr(USER_ID, { token: TOKEN });

        expect(result.result).toBe(ScanResult.BOOKING_INACTIVE);
        expect(monitoring.checkInBooking).not.toHaveBeenCalled();
      },
    );

    it('สแกนครั้งที่สาม (CHECKED_OUT แล้ว) → ALREADY_COMPLETED', async () => {
      prisma.jobSession.findUnique.mockResolvedValue(
        fakeSession({ status: JOB_SESSION_STATUS.CHECKED_OUT }),
      );

      const result = await service.scanJobQr(USER_ID, { token: TOKEN });

      expect(result.ok).toBe(false);
      expect(result.result).toBe(ScanResult.ALREADY_COMPLETED);
      expect(result.action).toBe(ScanAction.NONE);
      expect(monitoring.checkOutBooking).not.toHaveBeenCalled();
    });

    it('สแกนก่อนถึงช่วงเวลา → OUT_OF_WINDOW', async () => {
      prisma.jobSession.findUnique.mockResolvedValue(
        fakeSession({ validFrom: new Date('2026-06-13T05:00:00Z') }),
      );

      const result = await service.scanJobQr(USER_ID, { token: TOKEN });

      expect(result.result).toBe(ScanResult.OUT_OF_WINDOW);
      // ★ ยังบอก action ได้ เพราะผ่านด่านความเป็นเจ้าของงานมาแล้ว
      expect(result.action).toBe(ScanAction.CHECK_IN);
    });

    it('สแกนหลังหมดช่วงเวลา → OUT_OF_WINDOW', async () => {
      prisma.jobSession.findUnique.mockResolvedValue(
        fakeSession({ validUntil: new Date('2026-06-13T02:00:00Z') }),
      );

      const result = await service.scanJobQr(USER_ID, { token: TOKEN });

      expect(result.result).toBe(ScanResult.OUT_OF_WINDOW);
      expect(monitoring.checkInBooking).not.toHaveBeenCalled();
    });

    it('ไม่มีหลักฐานเช็คอินแต่ session บอก CHECKED_IN → WRONG_SEQUENCE', async () => {
      prisma.jobSession.findUnique.mockResolvedValue(
        fakeSession({
          status: JOB_SESSION_STATUS.CHECKED_IN,
          checkedInAt: new Date(NOW.getTime() - 3 * 60 * 60 * 1000),
        }),
      );
      prisma.jobEvent.findFirst.mockResolvedValue(null); // ข้อมูลสองตารางไม่ตรงกัน

      const result = await service.scanJobQr(USER_ID, { token: TOKEN });

      expect(result.result).toBe(ScanResult.WRONG_SEQUENCE);
      expect(monitoring.checkOutBooking).not.toHaveBeenCalled();
    });

    it('ระบบเช็คอินเดิมปฏิเสธ (ยังไม่จ่ายเงิน) → JOB_NOT_READY + ใช้ข้อความจริงจากระบบเดิม', async () => {
      monitoring.checkInBooking.mockRejectedValue(
        new BadRequestException('ยังไม่ได้รับการชำระเงิน'),
      );

      const result = await service.scanJobQr(USER_ID, { token: TOKEN });

      expect(result.ok).toBe(false);
      expect(result.result).toBe(ScanResult.JOB_NOT_READY);
      // ข้อความเจาะจงกว่าข้อความกลาง ๆ ที่เราจะเขียนเอง จึงส่งต่อไปตรง ๆ
      expect(result.message).toBe('ยังไม่ได้รับการชำระเงิน');
      // ★ สถานะของ QR ต้องไม่ขยับ
      expect(prisma.jobSession.updateMany).not.toHaveBeenCalled();
    });

    it('error ที่ไม่ใช่กติกาของงาน (ดีบีล่ม) → ปล่อยให้ throw ตามปกติ', async () => {
      monitoring.checkInBooking.mockRejectedValue(
        new NotFoundException('ไม่พบงานนี้'),
      );

      await expect(
        service.scanJobQr(USER_ID, { token: TOKEN }),
      ).rejects.toThrow(NotFoundException);
    });
  });

  // ════════════════════════════════════════════════════════════════════
  // C. Edge: สแกนรัว / แข่งกันสองรีเควสต์
  // ════════════════════════════════════════════════════════════════════
  describe('สแกนรัวและการแข่งกัน', () => {
    it('เพิ่งเช็คอินไปเมื่อครู่ → TOO_SOON (ไม่กลายเป็นเช็คเอาท์ทันที)', async () => {
      prisma.jobSession.findUnique.mockResolvedValue(
        fakeSession({
          status: JOB_SESSION_STATUS.CHECKED_IN,
          checkedInAt: new Date(NOW.getTime() - 2000), // 2 วินาทีที่แล้ว
        }),
      );

      const result = await service.scanJobQr(USER_ID, { token: TOKEN });

      expect(result.ok).toBe(false);
      expect(result.result).toBe(ScanResult.TOO_SOON);
      // ★ นี่คือหัวใจของเทสนี้: งานต้องไม่ถูกปิดใน 2 วินาที
      expect(monitoring.checkOutBooking).not.toHaveBeenCalled();
    });

    it('แพ้การแข่ง (updateMany ได้ 0 แถว) → DUPLICATE แต่ยังนับว่า ok', async () => {
      prisma.jobSession.updateMany.mockResolvedValue({ count: 0 });

      const result = await service.scanJobQr(USER_ID, { token: TOKEN });

      expect(result.result).toBe(ScanResult.DUPLICATE);
      // ok = "งานอยู่ในสถานะที่ตั้งใจแล้ว" ไม่ใช่ "ครั้งนี้เป็นคนทำ"
      // อีกรีเควสต์ทำสำเร็จไปแล้ว → FE ไม่ควรขึ้น error ให้ผู้ดูแลตกใจ
      expect(result.ok).toBe(true);
    });

    it('ขยับสถานะด้วยเงื่อนไขสถานะเดิมเสมอ (compare-and-swap)', async () => {
      await service.scanJobQr(USER_ID, { token: TOKEN });

      const call = prisma.jobSession.updateMany.mock.calls[0] as [
        { where: Record<string, unknown>; data: Record<string, unknown> },
      ];
      // ★ ถ้า where ไม่มี status การสแกนพร้อมกันจะผ่านทั้งคู่
      expect(call[0].where).toEqual({
        id: SESSION_ID,
        status: JOB_SESSION_STATUS.PENDING,
      });
      expect(call[0].data).toMatchObject({
        status: JOB_SESSION_STATUS.CHECKED_IN,
      });
    });

    it('ขยับสถานะ "หลัง" ทำงานจริงเสมอ — ถ้างานพัง สถานะต้องค้างที่เดิม', async () => {
      monitoring.checkInBooking.mockRejectedValue(
        new BadRequestException('งานนี้ยังไม่พร้อมเริ่ม'),
      );

      await service.scanJobQr(USER_ID, { token: TOKEN });

      // ค้างที่ PENDING → สแกนครั้งหน้ายังเช็คอินได้ (ซ่อมตัวเอง)
      expect(prisma.jobSession.updateMany).not.toHaveBeenCalled();
    });

    it('checked_in_at ใช้เวลาจากแถวหลักฐาน ไม่ใช่เวลาที่ service อ่านเอง', async () => {
      const eventTs = new Date('2026-06-13T03:05:00Z');
      monitoring.checkInBooking.mockResolvedValue(
        fakeJobEvent({ serverTs: eventTs }),
      );

      await service.scanJobQr(USER_ID, { token: TOKEN });

      const call = prisma.jobSession.updateMany.mock.calls[0] as [
        { data: Record<string, unknown> },
      ];
      // ถ้าสองตารางใช้คนละเวลา รายงานของแอดมินจะขัดกันเองในวันที่มีข้อพิพาท
      expect(call[0].data.checkedInAt).toBe(eventTs);
    });
  });

  // ════════════════════════════════════════════════════════════════════
  // D. AC "log ครบ" — บันทึกทุกครั้ง ทั้งสำเร็จและล้มเหลว
  // ════════════════════════════════════════════════════════════════════
  describe('บันทึกการสแกน (job_scan_events)', () => {
    it('สแกนสำเร็จ → มี 1 แถว พร้อม result = SUCCESS', async () => {
      await service.scanJobQr(USER_ID, { token: TOKEN });

      expect(prisma.jobScanEvent.create).toHaveBeenCalledTimes(1);
      expect(auditRow()).toMatchObject({
        sessionId: SESSION_ID,
        bookingId: BOOKING_ID,
        scannedBy: USER_ID,
        caregiverId: CAREGIVER_ID,
        action: SCAN_ACTION.CHECK_IN,
        result: SCAN_RESULT.SUCCESS,
        scannedAt: NOW,
      });
    });

    it('สแกนล้มเหลวก็ต้องมีแถว (AC: บันทึกทั้งสำเร็จและล้มเหลว)', async () => {
      prisma.jobSession.findUnique.mockResolvedValue(
        fakeSession({
          booking: { status: 'confirmed', caregiverId: OTHER_CAREGIVER_ID },
        }),
      );

      await service.scanJobQr(USER_ID, { token: TOKEN });

      expect(prisma.jobScanEvent.create).toHaveBeenCalledTimes(1);
      expect(auditRow()).toMatchObject({
        result: SCAN_RESULT.WRONG_CAREGIVER,
        action: SCAN_ACTION.NONE,
      });
    });

    it('token มั่ว ก็ยังบันทึก — โดย session/booking เป็น null', async () => {
      prisma.jobSession.findUnique.mockResolvedValue(null);

      await service.scanJobQr(USER_ID, { token: 'ของปลอม' });

      expect(auditRow()).toMatchObject({
        sessionId: null,
        bookingId: null,
        scannedBy: USER_ID,
        result: SCAN_RESULT.TOKEN_NOT_FOUND,
      });
    });

    it('★ เก็บ "hash" ของ token ที่สแกนมา ไม่ใช่ token ดิบ', async () => {
      await service.scanJobQr(USER_ID, { token: TOKEN });

      const row = auditRow();
      expect(row.tokenHash).toBe(TOKEN_HASH);
      expect(row.tokenHash).toMatch(/^[0-9a-f]{64}$/);
      // ต้องไม่มีค่าไหนในแถวที่เป็น token ดิบเลย
      expect(Object.values(row)).not.toContain(TOKEN);
    });

    it('เก็บข้อความไทยที่ผู้ดูแลเห็น ลงไปด้วย (ไว้ให้แอดมินอ่านย้อนหลัง)', async () => {
      prisma.jobSession.findUnique.mockResolvedValue(
        fakeSession({ status: JOB_SESSION_STATUS.CHECKED_OUT }),
      );

      const result = await service.scanJobQr(USER_ID, { token: TOKEN });

      expect(auditRow().reason).toBe(result.message);
      expect(result.message).toBe(
        SCAN_RESULT_MESSAGE[SCAN_RESULT.ALREADY_COMPLETED],
      );
    });

    it('เขียน log ไม่สำเร็จ ต้องไม่ทำให้การสแกนพัง', async () => {
      // ผู้ดูแลยืนอยู่หน้าบ้านลูกค้า — ตารางบันทึกมีปัญหาไม่ใช่เรื่องของเขา
      prisma.jobScanEvent.create.mockRejectedValue(new Error('db is down'));

      const result = await service.scanJobQr(USER_ID, { token: TOKEN });

      expect(result.ok).toBe(true);
      expect(result.result).toBe(ScanResult.SUCCESS);
    });
  });

  // ════════════════════════════════════════════════════════════════════
  // E. สัญญากับฝั่งอื่น — ถ้าชุดนี้แดง แปลว่า FE/QA/ดีบี จะไม่ตรงกัน
  // ════════════════════════════════════════════════════════════════════
  describe('ความสอดคล้องของรหัส', () => {
    it('enum ที่ GraphQL ใช้ ตรงกับ SCAN_RESULT ใน constants ทุกค่า', () => {
      expect(Object.keys(ScanResult).sort()).toEqual(
        Object.keys(SCAN_RESULT).sort(),
      );
    });

    it('enum ที่ GraphQL ใช้ ตรงกับ SCAN_ACTION ใน constants ทุกค่า', () => {
      expect(Object.keys(ScanAction).sort()).toEqual(
        Object.keys(SCAN_ACTION).sort(),
      );
    });

    it('enum JobSessionStatus ตรงกับ JOB_SESSION_STATUS ใน constants ทุกค่า (PYG-436)', () => {
      // สถานะของใบ QR อยู่ 3 ที่: constants / GraphQL enum / CHECK ในดีบี
      // เทสนี้จับสองที่แรก ที่สาม (ดีบี) ตรวจด้วย runbook ของ PYG-436
      expect(Object.keys(JobSessionStatus).sort()).toEqual(
        Object.keys(JOB_SESSION_STATUS).sort(),
      );
      expect(Object.values(JobSessionStatus).sort()).toEqual(
        Object.values(JOB_SESSION_STATUS).sort(),
      );
    });

    it('ค่าที่ดีบีให้มาแปลกปลอม → ตกไปที่ PENDING ไม่ทำให้ทั้งหน้าพัง (PYG-436)', () => {
      // ดีบีมี CHECK กันไว้แล้ว เคสนี้เกิดได้ก็ต่อเมื่อมีคนแก้ดีบีด้วยมือ
      // PENDING = "ยังไม่เริ่ม" ซึ่งปลอดภัยที่สุด — อย่างมากก็แค่ให้สแกนเช็คอินใหม่
      expect(toJobSessionStatus('CHECKED_IN')).toBe(
        JobSessionStatus.CHECKED_IN,
      );
      expect(toJobSessionStatus('ค่าที่ไม่มีจริง')).toBe(
        JobSessionStatus.PENDING,
      );
    });

    it('ทุกรหัสผลลัพธ์มีข้อความไทยรออยู่ (หรือ null แบบตั้งใจ)', () => {
      for (const code of Object.values(SCAN_RESULT)) {
        expect(SCAN_RESULT_MESSAGE).toHaveProperty(code);
      }
    });

    it('หา session ด้วย sha256 ของ token ที่สแกนมา', async () => {
      await service.scanJobQr(USER_ID, { token: TOKEN });

      expect(prisma.jobSession.findUnique).toHaveBeenCalledWith(
        expect.objectContaining({ where: { tokenHash: TOKEN_HASH } }),
      );
    });
  });
});
