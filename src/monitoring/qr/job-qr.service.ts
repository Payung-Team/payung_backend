import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { createHash, createHmac, randomBytes, randomUUID } from 'crypto';
import { PrismaService } from '../../common/prisma.service';
import { ClockService } from '../../common/clock.service';
import { scheduledEndOf, scheduledStartOf } from '../booking-schedule.util';
import { JobQr } from './entities/job-qr.entity';
import {
  JOB_SESSION_STATUS,
  QR_DEAD_BOOKING_STATUSES,
  QR_TOKEN_DOMAIN,
  QR_TOKEN_SECRET_ENV,
  QR_TOKEN_SECRET_MIN_LENGTH,
  QR_VALID_FROM_OFFSET_MIN,
  QR_VALID_UNTIL_GRACE_MIN,
} from './qr.constants';

/**
 * ข้อมูลขั้นต่ำของ booking ที่ใช้คำนวณช่วงเวลาของ QR
 *
 * รับเป็น interface แคบ ๆ แทนที่จะรับ Booking ทั้งก้อน เพื่อให้เห็นชัดว่า
 * service นี้ "อ่านแค่ 4 ฟิลด์นี้" และเขียนเทสได้โดยไม่ต้องปั้น booking ทั้งใบ
 */
export interface BookingScheduleForQr {
  id: string;
  bookingDate: Date;
  startTime: Date | null;
  durationHours: Prisma.Decimal | number;
}

/**
 * JobQrService — สร้างและอ่านใบ QR ของงาน (PYG-434 · การ์ดแม่ PYG-433)
 *
 * ══════════════════════════════════════════════════════════════════════════
 * ★★★ อ่านตรงนี้ก่อนแก้ไฟล์นี้: token ไม่ได้ถูกเก็บไว้ที่ไหนเลย ★★★
 * ══════════════════════════════════════════════════════════════════════════
 *
 * การ์ดสั่งไว้สองข้อที่ "ฟังดูขัดกันเอง":
 *   (1) เก็บ sha256(token) เท่านั้น ห้ามเก็บ token ดิบ
 *   (2) jobQr(bookingId) ต้องคืน raw token ให้ patient ได้ทุกเมื่อ
 * ถ้าเราสุ่ม token แล้วเก็บแต่ hash จริง ๆ ข้อ (2) จะทำไม่ได้เลย
 * เพราะ hash ย้อนกลับเป็น token ไม่ได้ (นั่นคือหน้าที่ของ hash)
 *
 * ทางออกที่ใช้ที่นี่: "ไม่เก็บ แต่คำนวณใหม่ได้"
 *
 *     token = HMAC-SHA256( QR_TOKEN_SECRET , "payung:jobqr:v1:<session id>" )
 *
 *   - QR_TOKEN_SECRET อยู่ใน ENV ของเซิร์ฟเวอร์ (ไม่อยู่ในดีบี ไม่อยู่ใน git)
 *   - session id คือ UUID ของแถวใน job_sessions
 *   - ผลลัพธ์ยาว 32 ไบต์ (ตรงตามที่การ์ดขอ) เข้ารหัสเป็น base64url 43 ตัวอักษร
 *
 *   ผลที่ได้:
 *     ✓ ดีบีเก็บแต่ sha256(token) ตามข้อ (1) เป๊ะ ๆ
 *     ✓ patient ขอดู QR กี่ครั้งก็ได้ ได้ค่าเดิมเสมอ ตามข้อ (2)
 *     ✓ QR ใบเดียวต่อ booking และไม่เปลี่ยนไปมา (ปริ้นท์แปะไว้ได้)
 *     ✓ คนที่ดัมพ์ดีบีไปทั้งก้อน "สร้าง QR ปลอมไม่ได้" เพราะไม่มี secret
 *
 * ⚠ ข้อแลกเปลี่ยนที่ต้องรู้: ความปลอดภัยทั้งหมดไปกองอยู่ที่ QR_TOKEN_SECRET
 *   ถ้ากุญแจหลุด = ปลอม QR ได้ทุกใบ (เหมือน JWT secret หลุด)
 *   วิธีกู้คืน: เปลี่ยนค่า QR_TOKEN_SECRET แล้ว QR เก่าตายหมดทันทีทุกใบ
 *   ⚠ แต่ token_hash เก่าในดีบีจะกลายเป็นขยะที่ไม่มีวันตรงกับอะไรอีก
 *     → ต้องรัน UPDATE เขียน token_hash ใหม่ทุกแถวด้วย (เขียน script ตอนนั้น)
 *
 * ── ทางเลือกอื่นที่พิจารณาแล้วไม่เลือก ────────────────────────────────────
 *   ✗ สุ่ม token ใหม่ทุกครั้งที่ patient เปิดหน้า (rotate on read)
 *     → ขัดข้อ "QR ใบเดียวต่อ booking" และ QR ที่ปริ้นท์/แคปไว้จะใช้ไม่ได้
 *   ✗ เก็บ token ดิบไว้ในดีบีตรง ๆ
 *     → ขัด AC ข้อ "เก็บ hash เท่านั้น" ตรง ๆ และดีบีหลุด = QR หลุดทั้งระบบ
 * ══════════════════════════════════════════════════════════════════════════
 */
@Injectable()
export class JobQrService {
  private readonly logger = new Logger(JobQrService.name);

  /** กุญแจลับที่ใช้เซ็น token — resolve ครั้งเดียวตอนแอปบูต */
  private readonly secret: Buffer;

  constructor(
    private readonly prisma: PrismaService,
    private readonly clock: ClockService,
  ) {
    this.secret = this.resolveSecret();
  }

  // ══════════════════════════════════════════════════════════════════════
  // สร้าง QR (ถูกเรียกจาก BookingService ตอนสร้าง booking)
  // ══════════════════════════════════════════════════════════════════════

  /**
   * สร้างใบ QR ให้ booking ที่เพิ่งถูกสร้าง
   *
   * ★ ต้องเรียกใน transaction เดียวกับที่สร้าง booking เสมอ (จึงบังคับรับ `tx`)
   *   ถ้าแยก transaction แล้วขั้นตอนนี้พัง จะได้ booking ที่ไม่มี QR ตลอดไป
   *   = ผู้ดูแลเช็คอินไม่ได้ และไม่มีอะไรในระบบคอยตามซ่อมให้
   *   AC ข้อแรกของการ์ดเขียนว่า "ทุก booking ใหม่มี JobSession PENDING + token"
   *   คำว่า "ทุก" จะเป็นจริงได้ก็ต่อเมื่อมันอยู่ใน transaction เดียวกันเท่านั้น
   *
   * ไม่คืน token ออกไป โดยตั้งใจ — ตอนสร้าง booking ยังไม่มีใครต้องใช้ QR
   * ยิ่งส่งค่าลับออกไปในที่ที่ไม่จำเป็น ยิ่งมีโอกาสหลุดไปโผล่ใน log ของใครสักคน
   */
  async createForBooking(
    tx: Prisma.TransactionClient,
    booking: BookingScheduleForQr,
  ): Promise<void> {
    // สร้าง id เองฝั่งแอป (ไม่ปล่อยให้ดีบี default) เพราะต้องรู้ค่า id
    // "ก่อน" INSERT — token คำนวณจาก id และเราต้องเก็บ hash ของมันลงแถวเดียวกัน
    const sessionId = randomUUID();
    const token = this.deriveToken(sessionId);
    const { validFrom, validUntil } = this.validityWindowOf(booking);

    await tx.jobSession.create({
      data: {
        id: sessionId,
        bookingId: booking.id,
        tokenHash: this.hashToken(token),
        status: JOB_SESSION_STATUS.PENDING,
        validFrom,
        validUntil,
      },
    });

    // ⚠ log แค่ id — ห้ามใส่ token หรือ tokenHash ลง log เด็ดขาด
    this.logger.log({
      event: 'job_qr.created',
      bookingId: booking.id,
      sessionId,
      validFrom: validFrom.toISOString(),
      validUntil: validUntil.toISOString(),
    });
  }

  // ══════════════════════════════════════════════════════════════════════
  // อ่าน QR (GraphQL query: jobQr)
  // ══════════════════════════════════════════════════════════════════════

  /**
   * คืนใบ QR ให้ patient เจ้าของ booking
   *
   * @param userId    users.id จาก JWT (ปลอมผ่าน argument ไม่ได้)
   * @param bookingId booking ที่อยากดู QR
   *
   * ด่านตรวจเรียงตามนี้ (ลำดับสำคัญ — อย่าสลับ):
   *   1. มี booking นี้จริงไหม
   *   2. เป็นงานของคนนี้ไหม     ← กันไม่ให้ caregiver หรือคนนอกดึง token ได้
   *   3. งานถูกยกเลิกไปแล้วหรือยัง
   *   4. มีใบ QR ไหม (booking เก่าก่อน migration จะไม่มี)
   */
  async jobQr(userId: string, bookingId: string): Promise<JobQr> {
    const booking = await this.prisma.booking.findUnique({
      where: { id: bookingId },
      select: {
        id: true,
        patientId: true,
        status: true,
        jobSession: true,
      },
    });

    // ─── ด่านที่ 1: มีงานนี้จริงไหม ───────────────────────────────────
    if (!booking) {
      throw new NotFoundException('ไม่พบงานนี้');
    }

    // ─── ด่านที่ 2: เป็นงานของคนนี้ไหม ────────────────────────────────
    //
    // ★ นี่คือด่านที่ทำให้ AC ข้อ "caregiver ดึง raw token ไม่ได้" เป็นจริง
    //   resolver กันด้วย @Roles(PATIENT) มาชั้นหนึ่งแล้ว แต่ยังไม่พอ
    //   เพราะ patient คนอื่นก็ยังยิง bookingId ของคนอื่นมาได้
    //
    // ⚠ PYG-424 (จองแทนในกลุ่มครอบครัว): booking.patientId = "คนกดจอง"
    //   → คนที่จองแทนจะเห็น QR ได้ ซึ่งถูกต้อง เพราะเขาเป็นคนไปส่ง QR ให้ผู้สูงอายุ
    //   แต่สมาชิกกลุ่มคนอื่น "ยังดูไม่ได้" — ตรงตามการ์ดที่เขียนว่า
    //   "เฉพาะ patient เจ้าของ booking" ถ้าทีมอยากให้ทั้งกลุ่มดูได้ ค่อยเปิดทีหลัง
    //   (เปิดง่ายกว่าปิด — ปล่อยหลุดไปแล้วเรียกคืนไม่ได้)
    if (booking.patientId !== userId) {
      throw new ForbiddenException('งานนี้ไม่ใช่ของคุณ');
    }

    // ─── ด่านที่ 3: งานถูกยกเลิก/ถูกปฏิเสธไปแล้วหรือยัง ───────────────
    //
    // Edge case ตรงจากการ์ด: "booking ถูกยกเลิก → session ใช้ไม่ได้"
    // สังเกตว่าเราไม่ได้ไปแตะ job_sessions.status ตอนยกเลิกงาน
    // แต่ตอบจาก bookings.status ตรงนี้แทน → มีความจริงชุดเดียว ไม่มีทางไม่ตรงกัน
    // (PYG-435 ต้องเช็คเงื่อนไขเดียวกันนี้ตอนสแกนด้วย — ห้ามลืม)
    if (
      (QR_DEAD_BOOKING_STATUSES as readonly string[]).includes(booking.status)
    ) {
      throw new BadRequestException('งานนี้ถูกยกเลิกแล้ว QR จึงใช้ไม่ได้');
    }

    // ─── ด่านที่ 4: มีใบ QR ไหม ───────────────────────────────────────
    //
    // booking ที่สร้างก่อน migration 20260828000000 จะไม่มีแถวใน job_sessions
    // (การ์ด PYG-436 ระบุว่า prototype นี้ "ข้าม" การ backfill โดยตั้งใจ)
    if (!booking.jobSession) {
      throw new NotFoundException(
        'งานนี้ยังไม่มี QR (เป็นงานที่จองไว้ก่อนระบบ QR เปิดใช้) กรุณาติดต่อผู้ดูแลระบบ',
      );
    }

    return this.toEntity(booking.jobSession);
  }

  // ══════════════════════════════════════════════════════════════════════
  // เลื่อนนัด (เตรียมไว้ให้การ์ดในอนาคต)
  // ══════════════════════════════════════════════════════════════════════

  /**
   * คำนวณช่วงเวลาของ QR ใหม่ตามตารางงานล่าสุด
   *
   * Edge case จากการ์ด: "reschedule → อัปเดต validFrom/Until หรือออก token ใหม่"
   * เลือกทางแรก (อัปเดตช่วงเวลา ไม่ออก token ใหม่) เพราะ QR ที่ผู้สูงอายุ
   * ปริ้นท์แปะไว้ที่ตู้เย็นแล้วต้องใช้ต่อได้ ถ้าออก token ใหม่ = ต้องปริ้นท์ใหม่ทุกครั้ง
   *
   * ⚠ ตอนนี้ "ยังไม่มีใครเรียก method นี้" เพราะระบบยังไม่มีฟีเจอร์เลื่อนนัดเลย
   *   (grep ทั้งรีโปแล้วไม่เจอคำว่า reschedule) วางไว้ให้การ์ดเลื่อนนัดในอนาคต
   *   เรียกบรรทัดเดียวจบ แทนที่จะต้องมานั่งคิดสูตรเวลาใหม่เองแล้วคิดไม่ตรงกับที่นี่
   */
  async resyncValidityWindow(bookingId: string): Promise<void> {
    const booking = await this.prisma.booking.findUnique({
      where: { id: bookingId },
      select: {
        id: true,
        bookingDate: true,
        startTime: true,
        durationHours: true,
        jobSession: { select: { id: true } },
      },
    });

    if (!booking?.jobSession) return; // ไม่มี QR ก็ไม่มีอะไรให้อัปเดต

    const { validFrom, validUntil } = this.validityWindowOf(booking);

    await this.prisma.jobSession.update({
      where: { id: booking.jobSession.id },
      data: { validFrom, validUntil, updatedAt: this.clock.now() },
    });

    this.logger.log({
      event: 'job_qr.validity_resynced',
      bookingId,
      validFrom: validFrom.toISOString(),
      validUntil: validUntil.toISOString(),
    });
  }

  // ══════════════════════════════════════════════════════════════════════
  // helper ที่การ์ดอื่นเรียกใช้ได้
  // ══════════════════════════════════════════════════════════════════════

  /**
   * แปลง token ที่สแกนมา → sha256 hex สำหรับค้นหาแถวใน job_sessions
   *
   * public เพราะ PYG-435 (scanJobQr) ต้องใช้ตัวนี้เป๊ะ ๆ ในการหา session
   * ถ้าไปเขียน createHash เองอีกที่ วันหนึ่งที่เปลี่ยนวิธี hash จะแก้ไม่ครบ
   */
  hashToken(token: string): string {
    return createHash('sha256').update(token, 'utf8').digest('hex');
  }

  // ══════════════════════════════════════════════════════════════════════
  // ภายใน
  // ══════════════════════════════════════════════════════════════════════

  /**
   * คำนวณ token จาก session id (ดูคำอธิบายเต็มที่หัวคลาส)
   *
   * base64url ไม่มีอักขระ + / = ที่ทำให้ QR reader และ URL เพี้ยน
   */
  private deriveToken(sessionId: string): string {
    return createHmac('sha256', this.secret)
      .update(`${QR_TOKEN_DOMAIN}:${sessionId}`, 'utf8')
      .digest('base64url');
  }

  /** ช่วงเวลาที่ QR ใช้ได้ = (เวลานัดเริ่ม − offset) ถึง (เวลานัดจบ + grace) */
  private validityWindowOf(booking: BookingScheduleForQr): {
    validFrom: Date;
    validUntil: Date;
  } {
    const start = scheduledStartOf(booking.bookingDate, booking.startTime);
    const end = scheduledEndOf(
      booking.bookingDate,
      booking.startTime,
      booking.durationHours,
    );

    const validFrom = new Date(
      start.getTime() - QR_VALID_FROM_OFFSET_MIN * 60_000,
    );
    let validUntil = new Date(
      end.getTime() + QR_VALID_UNTIL_GRACE_MIN * 60_000,
    );

    // กันพลาด: ดีบีมี CHECK ว่า valid_until ต้องมากกว่า valid_from เสมอ
    // ปกติเป็นจริงอยู่แล้ว (grace เป็นบวก + งานมีความยาว) แต่ถ้าวันหนึ่ง
    // มีใครตั้ง QR_VALID_UNTIL_GRACE_MIN เป็นค่าติดลบ การสร้าง booking
    // จะพังทั้งระบบเพราะ INSERT ไม่ผ่าน — ยอมขยับเวลาให้ ดีกว่าจองไม่ได้เลย
    if (validUntil <= validFrom) {
      validUntil = new Date(validFrom.getTime() + 60_000);
    }

    return { validFrom, validUntil };
  }

  /** แถวในดีบี → ก้อนข้อมูลที่ส่งให้ FE (เติม token + ค่าที่คำนวณตอนอ่าน) */
  private toEntity(session: {
    id: string;
    bookingId: string;
    status: string;
    validFrom: Date;
    validUntil: Date;
  }): JobQr {
    const now = this.clock.now();

    // สแกนครั้งต่อไปคือ action อะไร — ตัดสินจากสถานะปัจจุบันเท่านั้น
    // (หลักการของการ์ดแม่ PYG-433: "action ตัดสินจากสถานะ ไม่ใช่จากตัว QR")
    const nextAction =
      session.status === JOB_SESSION_STATUS.PENDING
        ? 'CHECK_IN'
        : session.status === JOB_SESSION_STATUS.CHECKED_IN
          ? 'CHECK_OUT'
          : null; // CHECKED_OUT = ปิดงานแล้ว ไม่เหลือ action

    return {
      bookingId: session.bookingId,
      token: this.deriveToken(session.id),
      status: session.status,
      validFrom: session.validFrom,
      validUntil: session.validUntil,
      isActive:
        nextAction !== null &&
        now >= session.validFrom &&
        now <= session.validUntil,
      nextAction: nextAction ?? undefined,
    };
  }

  /**
   * หากุญแจลับตอนแอปบูต
   *
   * ★ production: ไม่มีกุญแจ = แอปไม่ยอมบูต (ตั้งใจให้พังเสียงดัง)
   *   ถ้าปล่อยให้บูตได้โดยใช้กุญแจสุ่ม ทุกครั้งที่ deploy/restart
   *   QR ของ booking ทุกใบจะเปลี่ยนเงียบ ๆ แล้วผู้ดูแลจะสแกนไม่ผ่านโดยไม่มีใครรู้สาเหตุ
   *
   * ★ dev/test: ไม่มีกุญแจ = สุ่มให้ 1 ชุดต่อการรันหนึ่งครั้ง + เตือนดัง ๆ
   *   เพื่อให้เพื่อนร่วมทีมที่ยังไม่ได้อัปเดต .env รันโปรเจกต์ต่อได้ตามปกติ
   *   (แลกกับข้อจำกัดว่า QR ที่ออกก่อน restart จะใช้ไม่ได้ ซึ่งยอมรับได้ตอน dev)
   */
  private resolveSecret(): Buffer {
    const raw = process.env[QR_TOKEN_SECRET_ENV];

    if (raw && raw.length >= QR_TOKEN_SECRET_MIN_LENGTH) {
      return Buffer.from(raw, 'utf8');
    }

    const problem = raw
      ? `สั้นเกินไป (ต้องยาวอย่างน้อย ${QR_TOKEN_SECRET_MIN_LENGTH} ตัวอักษร)`
      : 'ไม่ได้ตั้งค่าไว้';

    if (process.env.NODE_ENV === 'production') {
      throw new Error(
        `${QR_TOKEN_SECRET_ENV} ${problem} — ระบบ QR ทำงานไม่ได้ (ดู .env.example)`,
      );
    }

    this.logger.warn(
      `${QR_TOKEN_SECRET_ENV} ${problem} → ใช้กุญแจสุ่มชั่วคราวสำหรับรอบนี้. ` +
        'QR ที่ออกไปก่อนหน้านี้จะสแกนไม่ผ่าน และจะเปลี่ยนอีกครั้งเมื่อ restart. ' +
        'ตั้งค่าใน .env ก่อนใช้งานจริง',
    );
    return randomBytes(32);
  }
}
