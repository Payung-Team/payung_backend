import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../common/prisma.service';
import { ClockService } from '../../common/clock.service';
import { MonitoringService } from '../monitoring.service';
import { JOB_EVENT_TYPE } from '../monitoring.constants';
import { JobEvent } from '../entities/job-event.entity';
import { JobQrService } from './job-qr.service';
import { ScanJobQrInput } from './dto/scan-job-qr.input';
import { JobScanResult } from './entities/job-scan-result.entity';
import { ScanAction, ScanResult } from './entities/scan-result.enum';
import { toJobSessionStatus } from './entities/job-session-status.enum';
import {
  JOB_SESSION_STATUS,
  QR_DEAD_BOOKING_STATUSES,
  QR_MIN_SECONDS_BETWEEN_ACTIONS,
  QR_SINGLE_USE_PER_ACTION,
  SCAN_RESULT_MESSAGE,
} from './qr.constants';

/**
 * ข้อมูลที่ต้องบันทึกลง job_scan_events 1 แถว
 * (แยกเป็น type เพื่อให้ทุกทางออกของ scanJobQr ส่งของครบเหมือนกันหมด)
 */
interface ScanOutcome {
  result: ScanResult;
  action: ScanAction;
  sessionId: string | null;
  bookingId: string | null;
  sessionStatus: string | null;
  /** ข้อความเฉพาะกิจ — ถ้าไม่ส่งมา จะใช้ข้อความกลางจาก SCAN_RESULT_MESSAGE */
  message?: string;
  jobEvent?: JobEvent;
}

/**
 * JobScanService — สแกน QR แล้วเริ่ม/จบงาน (PYG-435 · การ์ดแม่ PYG-433)
 *
 * ══════════════════════════════════════════════════════════════════════════
 * ★★★ หลักคิดของไฟล์นี้ — อ่านก่อนแก้ ★★★
 * ══════════════════════════════════════════════════════════════════════════
 *
 * ① การสแกน "คือ" การเช็คอิน/เช็คเอาท์ ไม่ใช่ขั้นตอนที่ทำก่อนหน้า
 *    การ์ดแม่เขียนว่า "สแกนครั้งแรก = check-in, สแกนครั้งสอง = check-out"
 *    → mutation นี้จึงทำงานให้เสร็จในครั้งเดียว ไม่ได้ออกใบอนุญาตให้ไปกดต่อ
 *    ทางเลือกอีกแบบ (สแกนแล้วได้ตั๋วไปกดปุ่มเช็คอินอีกที) ถูกพิจารณาแล้วไม่เลือก
 *    เพราะมันเพิ่มสถานะกลางทางที่ต้องหมดอายุเอง แลกกับความปลอดภัยที่เท่าเดิม
 *
 * ② ไฟล์นี้ "ไม่คำนวณอะไรเกี่ยวกับงานเองเลย"
 *    ธง GPS / ระยะเวลาทำงาน / verdict / สถานะ booking / การแจ้งเตือน
 *    ทั้งหมดยังเป็นของ MonitoringService (PYG-352/358) เหมือนเดิมทุกบรรทัด
 *    หน้าที่ของไฟล์นี้มีอย่างเดียว: ตรวจว่า "คนนี้ ใบนี้ เวลานี้ สแกนได้ไหม"
 *    แล้วส่งไม้ต่อ ถ้าวันหนึ่งมีสูตรคำนวณโผล่ในไฟล์นี้ แปลว่าวางผิดที่แล้ว
 *
 * ③ ทุกทางออกต้องบันทึกลง job_scan_events — รวมทั้งครั้งที่ล้มเหลว
 *    บังคับด้วยโครงสร้าง: ทุก return วิ่งผ่าน finish() ที่เดียว
 *    (AC: "เขียน JobScanEvent ทุกครั้ง (สำเร็จ+ล้มเหลว)")
 *
 * ④ ลำดับด่านตรวจสำคัญมาก — ห้ามสลับ
 *    เรียงจาก "รู้น้อยที่สุด" ไป "รู้มากที่สุด" และจาก "บอกได้" ไป "บอกไม่ได้":
 *    คนที่ถือ QR ของคนอื่นต้องเจอ WRONG_CAREGIVER ก่อนที่จะได้รู้ว่างานใบนั้น
 *    อยู่สถานะไหนหรือมีตารางเวลาอย่างไร
 * ══════════════════════════════════════════════════════════════════════════
 */
@Injectable()
export class JobScanService {
  private readonly logger = new Logger(JobScanService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly clock: ClockService,
    private readonly jobQrService: JobQrService,
    private readonly monitoringService: MonitoringService,
  ) {}

  /**
   * ผู้ดูแลสแกน QR ของงาน
   *
   * @param userId users.id จาก JWT (ปลอมผ่าน argument ไม่ได้)
   *
   * ★ method นี้ "แทบไม่ throw เลย" โดยตั้งใจ — ดูเหตุผลเต็มที่ JobScanResult
   *   สิ่งเดียวที่ยัง throw คือความผิดปกติของระบบจริง ๆ (ดีบีล่ม ฯลฯ)
   */
  async scanJobQr(
    userId: string,
    input: ScanJobQrInput,
  ): Promise<JobScanResult> {
    const now = this.clock.now();

    // hash ด้วยฟังก์ชันเดียวกับตอนสร้าง QR เป๊ะ ๆ (ห้ามเขียน createHash เองที่นี่)
    const tokenHash = this.jobQrService.hashToken(input.token);

    // ─── ด่านที่ 1: คนสแกนมีโปรไฟล์ผู้ดูแลไหม ─────────────────────────
    //
    // resolver กันด้วย @Roles(CAREGIVER) มาแล้ว ด่านนี้จับกรณีข้อมูลเพี้ยน:
    // role เป็น 2 แต่ไม่มีแถวใน caregivers (สมัครค้างกลางทาง / ข้อมูลถูกลบ)
    const caregiver = await this.prisma.caregiver.findUnique({
      where: { userId },
      select: { id: true },
    });

    if (!caregiver) {
      return this.finish(userId, null, tokenHash, now, {
        result: ScanResult.NOT_A_CAREGIVER,
        action: ScanAction.NONE,
        sessionId: null,
        bookingId: null,
        sessionStatus: null,
      });
    }

    const caregiverId = caregiver.id;

    // ─── ด่านที่ 2: token นี้ตรงกับ QR ใบไหน ──────────────────────────
    const session = await this.prisma.jobSession.findUnique({
      where: { tokenHash },
      select: {
        id: true,
        bookingId: true,
        status: true,
        validFrom: true,
        validUntil: true,
        checkedInAt: true,
        booking: { select: { status: true, caregiverId: true } },
      },
    });

    // ไม่เจอ = QR ปลอม / QR ของระบบอื่น / กล้องอ่านเพี้ยน
    // ★ ตอบสั้น ๆ เท่านั้น ห้ามบอกว่า "token ผิดตรงไหน" — ช่วยคนเดาให้ง่ายขึ้นเปล่า ๆ
    if (!session) {
      return this.finish(userId, caregiverId, tokenHash, now, {
        result: ScanResult.TOKEN_NOT_FOUND,
        action: ScanAction.NONE,
        sessionId: null,
        bookingId: null,
        sessionStatus: null,
      });
    }

    const base = {
      sessionId: session.id,
      bookingId: session.bookingId,
      sessionStatus: session.status,
    };

    // ─── ด่านที่ 3: เป็นงานของผู้ดูแลคนนี้ไหม ─────────────────────────
    //
    // ★ ด่านนี้ต้องมาก่อนด่านอื่นที่เหลือทั้งหมด
    //   คนที่ถ่ายรูป QR ของคนอื่นมา ต้องไม่ได้รู้อะไรเกี่ยวกับงานใบนั้นเลย
    //   ไม่ว่าจะเป็นสถานะ ตารางเวลา หรือแม้แต่ว่ามันถูกยกเลิกไปแล้ว
    //
    // ⚠ ครอบคลุม edge case "caregiver ถูกเปลี่ยนกลางคัน" จากการ์ดด้วย:
    //   เทียบกับ bookings.caregiver_id "ตอนนี้" ไม่ใช่ตอนที่ QR ถูกสร้าง
    //   → ผู้ดูแลคนเก่าที่ยังถือ QR อยู่ในมือ สแกนไม่ผ่านทันทีที่ถูกเปลี่ยนตัว
    //   (caregiverId เป็น null ได้ = ยังไม่มีใครรับงาน → ก็ไม่ผ่านเช่นกัน)
    if (session.booking.caregiverId !== caregiverId) {
      return this.finish(userId, caregiverId, tokenHash, now, {
        ...base,
        result: ScanResult.WRONG_CAREGIVER,
        action: ScanAction.NONE,
      });
    }

    // ─── ด่านที่ 4: งานถูกยกเลิก/ปฏิเสธไปแล้วหรือยัง ──────────────────
    //
    // อ่านจาก bookings.status ที่เดียว ไม่ได้ไปแตะ job_sessions.status ตอนยกเลิก
    // (เหตุผลเดียวกับ jobQr() ใน PYG-434 — มีความจริงชุดเดียว ไม่มีทางไม่ตรงกัน)
    if (
      (QR_DEAD_BOOKING_STATUSES as readonly string[]).includes(
        session.booking.status,
      )
    ) {
      return this.finish(userId, caregiverId, tokenHash, now, {
        ...base,
        result: ScanResult.BOOKING_INACTIVE,
        action: ScanAction.NONE,
      });
    }

    // ─── ด่านที่ 5: ยังเหลือ action ให้ทำไหม ──────────────────────────
    //
    // ★★ หัวใจของทั้งฟีเจอร์: "ตัว QR ไม่ได้บอกว่าจะทำอะไร สถานะเป็นตัวบอก" ★★
    //    input จึงไม่มีฟิลด์ action ให้ client ส่งมา (ดู ScanJobQrInput)
    //    AC "สแกนซ้ำครั้งที่สาม reject" เป็นจริงตรงนี้เอง — ไม่ต้องนับจำนวนครั้ง
    if (session.status === JOB_SESSION_STATUS.CHECKED_OUT) {
      return this.finish(userId, caregiverId, tokenHash, now, {
        ...base,
        result: ScanResult.ALREADY_COMPLETED,
        action: ScanAction.NONE,
      });
    }

    const action =
      session.status === JOB_SESSION_STATUS.PENDING
        ? ScanAction.CHECK_IN
        : ScanAction.CHECK_OUT;

    // ─── ด่านที่ 6: อยู่ในช่วงเวลาที่สแกนได้ไหม ───────────────────────
    //
    // ช่วงเวลาถูกคำนวณไว้ตอนสร้าง QR แล้ว (valid_from..valid_until)
    // ที่นี่แค่เทียบ ไม่คำนวณใหม่ — ถ้าคำนวณใหม่ที่นี่ด้วย วันที่สูตรเปลี่ยน
    // QR ที่ออกไปแล้วจะเปลี่ยนช่วงเวลาย้อนหลังโดยไม่มีใครตั้งใจ
    if (now < session.validFrom || now > session.validUntil) {
      return this.finish(userId, caregiverId, tokenHash, now, {
        ...base,
        result: ScanResult.OUT_OF_WINDOW,
        action,
      });
    }

    // ─── ด่านที่ 7: สแกนถี่เกินไปหรือเปล่า ────────────────────────────
    //
    // Edge case ตรงจากการ์ด: "สแกนรัว 2 ครั้ง"
    // กล้องของ browser ยิงซ้ำติด ๆ กันได้จริง ถ้าไม่กัน ครั้งที่สองจะเห็นสถานะ
    // เป็น CHECKED_IN แล้ว → กลายเป็นเช็คเอาท์ทันที = งานเปิดแล้วปิดใน 1 วินาที
    //
    // มีผลเฉพาะตอนจะเช็คเอาท์ (ตอน PENDING ยังไม่เคยมี action มาก่อน)
    if (session.checkedInAt) {
      const elapsedSec = (now.getTime() - session.checkedInAt.getTime()) / 1000;
      if (elapsedSec < QR_MIN_SECONDS_BETWEEN_ACTIONS) {
        return this.finish(userId, caregiverId, tokenHash, now, {
          ...base,
          result: ScanResult.TOO_SOON,
          action,
        });
      }
    }

    // ─── ด่านที่ 8: ลำดับถูกต้องไหม ───────────────────────────────────
    //
    // ★ ปกติด่านนี้ "ไม่มีวันไม่ผ่าน" เพราะ session จะเป็น CHECKED_IN ได้
    //   ก็ต่อเมื่อเช็คอินสำเร็จไปแล้วเท่านั้น → หลักฐานเช็คอินต้องมีอยู่แน่นอน
    //   ที่ยังตรวจ เพราะข้อมูลสองตารางอาจไม่ตรงกันได้ (แอดมินลบแถวหลักฐานทิ้ง /
    //   กู้ข้อมูลมาไม่ครบ) แล้ว MonitoringService จะ throw ออกมาแทนที่จะตอบสวย ๆ
    //
    //   ตรวจเองที่นี่ดีกว่าไปจับข้อความ error จากอีกไฟล์ — ข้อความถูกแก้เมื่อไรก็พังเมื่อนั้น
    if (action === ScanAction.CHECK_OUT) {
      const checkIn = await this.prisma.jobEvent.findFirst({
        where: {
          bookingId: session.bookingId,
          eventType: JOB_EVENT_TYPE.CHECK_IN,
        },
        select: { id: true },
      });

      if (!checkIn) {
        return this.finish(userId, caregiverId, tokenHash, now, {
          ...base,
          result: ScanResult.WRONG_SEQUENCE,
          action,
          message: 'ยังไม่มีบันทึกการเริ่มงาน จึงจบงานไม่ได้',
        });
      }
    }

    // ══════════════════════════════════════════════════════════════════
    // ผ่านทุกด่านแล้ว — ส่งไม้ต่อให้ระบบเช็คอิน/เช็คเอาท์เดิม
    // ══════════════════════════════════════════════════════════════════
    let jobEvent: JobEvent;
    try {
      jobEvent =
        action === ScanAction.CHECK_IN
          ? await this.monitoringService.checkInBooking(
              userId,
              {
                bookingId: session.bookingId,
                lat: input.lat,
                lng: input.lng,
                accuracyM: input.accuracyM,
                deviceTs: input.deviceTs,
              },
              // ★ กุญแจที่ไขประตูของ assertScanned() — มีที่เดียวในระบบคือสองบรรทัดนี้
              { viaScan: true },
            )
          : await this.monitoringService.checkOutBooking(
              userId,
              {
                bookingId: session.bookingId,
                lat: input.lat,
                lng: input.lng,
                accuracyM: input.accuracyM,
                deviceTs: input.deviceTs,
                note: input.note,
                photoUrl: input.photoUrl,
              },
              { viaScan: true },
            );
    } catch (error) {
      // กติกาของงาน (ยังไม่ถึงวัน / ยังไม่จ่ายเงิน / สถานะไม่ใช่ confirmed /
      // ไฟล์แนบไม่ผ่าน) → ตอบเป็นผลลัพธ์ปกติ พร้อมข้อความจริงจากระบบเดิม
      // ซึ่งเจาะจงกว่าข้อความกลาง ๆ ที่เราจะเขียนเองมาก
      if (error instanceof BadRequestException) {
        return this.finish(userId, caregiverId, tokenHash, now, {
          ...base,
          result: ScanResult.JOB_NOT_READY,
          action,
          message: this.messageOf(error),
        });
      }
      // อย่างอื่น (ดีบีล่ม / บั๊ก) = ความผิดปกติจริง ปล่อยให้ขึ้นไปเป็น error ตามปกติ
      // ⚠ เคสนี้จะ "ไม่มีแถวใน job_scan_events" โดยตั้งใจ — เพราะเราไม่รู้ด้วยซ้ำ
      //   ว่าเกิดอะไรขึ้น การเดาแล้วบันทึกมั่ว ๆ แย่กว่าการไม่บันทึก
      throw error;
    }

    // ══════════════════════════════════════════════════════════════════
    // ขยับสถานะของ QR — จุดเดียวที่กันการสแกนพร้อมกันได้จริง
    // ══════════════════════════════════════════════════════════════════
    //
    // ★ ใช้ updateMany + เงื่อนไข status เดิม = compare-and-swap ของ Postgres
    //   (UPDATE ... WHERE status = 'PENDING' เป็น atomic ในตัวมันเอง)
    //   ถ้าสองรีเควสต์วิ่งมาพร้อมกัน จะมีแค่ตัวเดียวที่ได้ count = 1
    //   ตัวที่ได้ 0 แปลว่า "มีคนทำไปแล้ว" ไม่ใช่ "ทำไม่สำเร็จ"
    //
    // ⚠ ทำไมขยับสถานะ "หลัง" ทำงานจริง ไม่ใช่ก่อน:
    //   ถ้าขยับก่อนแล้วเช็คอินพัง จะได้ QR ที่บอกว่า CHECKED_IN แต่ไม่มีหลักฐาน
    //   → ผู้ดูแลเช็คอินซ้ำก็ไม่ได้ (สถานะเลยไปแล้ว) เช็คเอาท์ก็ไม่ได้ (ไม่มีเช็คอิน) = งานตาย
    //   เรียงแบบนี้แทน ถ้าขั้นตอนขยับพัง สถานะจะค้างที่เดิม แล้วการสแกนครั้งหน้า
    //   จะทำงานเดิมซ้ำ (ซึ่ง MonitoringService รองรับอยู่แล้ว คืนแถวเดิมให้) แล้วขยับต่อ = ซ่อมตัวเอง
    const advanced = await this.prisma.jobSession.updateMany({
      where: {
        id: session.id,
        // ★ เงื่อนไขนี้คือตัวล็อก ห้ามเอาออก
        status:
          action === ScanAction.CHECK_IN
            ? JOB_SESSION_STATUS.PENDING
            : JOB_SESSION_STATUS.CHECKED_IN,
      },
      data:
        action === ScanAction.CHECK_IN
          ? {
              status: JOB_SESSION_STATUS.CHECKED_IN,
              // ใช้เวลาจากแถวหลักฐาน ไม่ใช่ now ของเราเอง
              // เพื่อให้ job_sessions กับ job_events พูดตรงกันเป๊ะ
              checkedInAt: jobEvent.serverTs,
              updatedAt: now,
            }
          : {
              status: JOB_SESSION_STATUS.CHECKED_OUT,
              checkedOutAt: jobEvent.serverTs,
              updatedAt: now,
            },
    });

    const nextStatus =
      action === ScanAction.CHECK_IN
        ? JOB_SESSION_STATUS.CHECKED_IN
        : JOB_SESSION_STATUS.CHECKED_OUT;

    // แพ้การแข่ง = อีกรีเควสต์ทำงานเดียวกันไปแล้ว
    // ★ ยัง ok = true เพราะ "งานอยู่ในสถานะที่ตั้งใจ" แล้วจริง ๆ
    //   (แนวเดียวกับ checkInBooking เดิมที่กดซ้ำแล้วคืนแถวเดิมให้ ไม่ error)
    if (advanced.count === 0 && QR_SINGLE_USE_PER_ACTION) {
      return this.finish(userId, caregiverId, tokenHash, now, {
        ...base,
        result: ScanResult.DUPLICATE,
        action,
        sessionStatus: nextStatus,
        jobEvent,
      });
    }

    return this.finish(userId, caregiverId, tokenHash, now, {
      ...base,
      result: ScanResult.SUCCESS,
      action,
      sessionStatus: nextStatus,
      jobEvent,
    });
  }

  // ══════════════════════════════════════════════════════════════════════
  // ภายใน
  // ══════════════════════════════════════════════════════════════════════

  /**
   * ทางออกเดียวของ scanJobQr — บันทึก log แล้วปั้นคำตอบ
   *
   * ★ ที่ให้ทุก return วิ่งผ่านฟังก์ชันเดียว ไม่ใช่เรื่องความสวยของโค้ด
   *   แต่เพราะ AC บังคับว่า "เขียน JobScanEvent ทุกครั้ง" — ถ้ากระจาย
   *   this.prisma.jobScanEvent.create() ไว้ 11 จุด วันหนึ่งจะมีจุดที่ลืม
   *   และมันจะเป็นจุดที่สำคัญที่สุดเสมอ (เคสที่ไม่มีใครคิดว่าจะเกิด)
   */
  private async finish(
    userId: string,
    caregiverId: string | null,
    tokenHash: string,
    now: Date,
    outcome: ScanOutcome,
  ): Promise<JobScanResult> {
    const message =
      outcome.message ?? SCAN_RESULT_MESSAGE[outcome.result] ?? 'สแกนไม่สำเร็จ';

    await this.writeAuditRow(
      userId,
      caregiverId,
      tokenHash,
      now,
      outcome,
      message,
    );

    // ok = "งานอยู่ในสถานะที่คุณตั้งใจจะทำให้เป็นแล้วหรือยัง"
    // ไม่ใช่ "การเรียกครั้งนี้เป็นคนทำหรือเปล่า" → DUPLICATE จึงนับเป็น ok
    const ok =
      outcome.result === ScanResult.SUCCESS ||
      outcome.result === ScanResult.DUPLICATE;

    return {
      ok,
      result: outcome.result,
      action: outcome.action,
      message,
      bookingId: outcome.bookingId ?? undefined,
      // PYG-436: แปลงเป็น enum ตรงทางออกที่เดียว (ค่าที่นี่มาจากดีบีหรือจาก
      // JOB_SESSION_STATUS ซึ่งตรงกันอยู่แล้ว — แปลงเพื่อให้ type ตรงกับ schema)
      sessionStatus: outcome.sessionStatus
        ? toJobSessionStatus(outcome.sessionStatus)
        : undefined,
      scannedAt: now,
      jobEvent: outcome.jobEvent,
    };
  }

  /**
   * เขียน 1 แถวลง job_scan_events
   *
   * ★ ห่อ try/catch ไว้โดยตั้งใจ — การบันทึก log ต้องไม่มีวันทำให้คำตอบพัง
   *   ผู้ดูแลที่ยืนอยู่หน้าบ้านลูกค้าต้องเช็คอินได้ แม้ตารางบันทึกจะมีปัญหา
   *
   * ⚠ ข้อแลกเปลี่ยนที่ต้องรู้: ถ้าเขียนไม่สำเร็จ เราจะ "เสีย log แถวนั้นไป"
   *   จึงต้อง logger.error ให้ดังพอที่ระบบมอนิเตอร์จะเห็น ไม่ใช่กลืนเงียบ ๆ
   *   ในทางปฏิบัติมันจะพังก็ต่อเมื่อดีบีล่ม ซึ่งตอนนั้นการเช็คอินก็พังไปแล้ว
   *
   * ⚠ ห้ามใส่ input.token ดิบลง log เด็ดขาด — เก็บแต่ hash เหมือนที่อื่นทั้งระบบ
   */
  private async writeAuditRow(
    userId: string,
    caregiverId: string | null,
    tokenHash: string,
    now: Date,
    outcome: ScanOutcome,
    message: string,
  ): Promise<void> {
    try {
      await this.prisma.jobScanEvent.create({
        data: {
          sessionId: outcome.sessionId,
          bookingId: outcome.bookingId,
          scannedBy: userId,
          caregiverId,
          tokenHash,
          action: outcome.action,
          result: outcome.result,
          reason: message,
          scannedAt: now,
        },
      });
    } catch (error) {
      this.logger.error({
        event: 'job_scan.audit_write_failed',
        result: outcome.result,
        action: outcome.action,
        bookingId: outcome.bookingId,
        error: error instanceof Error ? error.message : String(error),
      });
      return;
    }

    // log ปกติ เขียนหลังบันทึกสำเร็จ เพื่อให้จำนวนบรรทัดใน log ตรงกับจำนวนแถวในตาราง
    this.logger.log({
      event: 'job_scan',
      result: outcome.result,
      action: outcome.action,
      bookingId: outcome.bookingId,
      sessionStatus: outcome.sessionStatus,
      caregiverId,
    });
  }

  /** ดึงข้อความไทยออกจาก HttpException (โครงของ payload ต่างกันได้ตามวิธี throw) */
  private messageOf(error: BadRequestException): string {
    const response = error.getResponse();
    if (typeof response === 'string') return response;
    if (
      typeof response === 'object' &&
      response !== null &&
      'message' in response
    ) {
      const value = (response as { message: unknown }).message;
      if (typeof value === 'string') return value;
      if (Array.isArray(value) && typeof value[0] === 'string') return value[0];
    }
    return error.message;
  }
}
