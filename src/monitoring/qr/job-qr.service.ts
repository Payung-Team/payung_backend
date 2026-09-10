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
import { toJobSessionStatus } from './entities/job-session-status.enum';
import { ScanAction } from './entities/scan-result.enum';
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
 * action ที่ "มี token เป็นของตัวเอง" — CHECK_IN กับ CHECK_OUT เท่านั้น
 * NONE ไม่มี token เพราะมันแปลว่า "ไม่เหลืออะไรให้ทำแล้ว" (ปิดงานไปแล้ว)
 */
export type TokenAction = ScanAction.CHECK_IN | ScanAction.CHECK_OUT;

/** ฟิลด์ของแถว job_sessions ที่การคำนวณ token ต้องใช้ */
interface SessionTokenFields {
  id: string;
  status: string;
  tokenHash: string;
  updatedAt: Date;
}

/** แถวเต็มที่พอสำหรับปั้นคำตอบส่งให้ FE */
type SessionRow = SessionTokenFields & {
  validFrom: Date;
  validUntil: Date;
};

/**
 * JobQrService — สร้างและอ่านใบ QR ของงาน (PYG-434 · ปรับสูตร token ที่ PYG-437)
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
 *     token = HMAC-SHA256( QR_TOKEN_SECRET , "payung:jobqr:v2:<id>:<action>:<rev>" )
 *
 *   - QR_TOKEN_SECRET  อยู่ใน ENV ของเซิร์ฟเวอร์ (ไม่อยู่ในดีบี ไม่อยู่ใน git)
 *   - id     = UUID ของแถวใน job_sessions
 *   - action = CHECK_IN หรือ CHECK_OUT           ← ★ เพิ่มใน PYG-437
 *   - rev    = updated_at ของแถวนั้น (มิลลิวินาที) ← ★ เพิ่มใน PYG-437
 *   ผลลัพธ์ 32 ไบต์ เข้ารหัสเป็น base64url 43 ตัวอักษร
 *
 * ══════════════════════════════════════════════════════════════════════════
 * ★★★ PYG-437 เปลี่ยนอะไร และทำไมถึงกลับคำตัดสินใจเดิมของ PYG-434 ★★★
 * ══════════════════════════════════════════════════════════════════════════
 *
 * เดิม (v1) สูตรมีแค่ `<id>` → QR ใบเดียวต่อ booking ไม่มีวันเปลี่ยน
 * ตั้งใจไว้ให้ผู้สูงอายุ "ปริ้นท์ QR แปะตู้เย็น" ได้ และปฏิเสธแนวคิด rotate ไปแล้ว
 *
 * ทีมขอเปลี่ยน โดยรับข้อแลกเปลี่ยนแล้ว:
 *   ✗ เสียไป : ปริ้นท์แปะล่วงหน้าไม่ได้อีก (ใบที่ปริ้นท์ตายทันทีที่เช็คอินสำเร็จ)
 *   ✓ ได้มา  : QR หลุด (ถูกถ่ายรูป/ส่งต่อในแชต) → ผู้รับบริการกดออกใบใหม่ได้เอง
 *              ใบที่หลุดไปตายทันที ไม่ต้องรอแอดมิน
 *   ✓ ได้มา  : token ของ "เริ่มงาน" กับ "จบงาน" เป็นคนละค่ากัน
 *              → ใครถือ QR ตอนเริ่มงานไว้ เอาไปปิดงานเองไม่ได้
 *              → "สแกนรัวสองครั้งแล้วงานเปิด-ปิดใน 1 วินาที" หมดไปที่ระดับโครงสร้าง
 *                (เดิมกันด้วย QR_MIN_SECONDS_BETWEEN_ACTIONS ซึ่งเป็นแค่การหน่วงเวลา)
 *
 * ══════════════════════════════════════════════════════════════════════════
 * ★★★ ทำไมใช้ updated_at เป็น "เลขรอบ" แทนที่จะเพิ่มคอลัมน์ใหม่ ★★★
 * ══════════════════════════════════════════════════════════════════════════
 *
 * ทางที่สะอาดที่สุดคือเพิ่มคอลัมน์ token_version INTEGER แล้วนับ 0, 1, 2, ...
 * แต่นั่นต้องมี migration ซึ่งทีมยังไม่เปิดให้ทำ
 * → รายละเอียดว่าถ้าจะทำต้อง migrate อะไรบ้าง อยู่ที่
 *   docs/pyg437-qr-token-rotation-migration-report.md
 *
 * updated_at ทำหน้าที่แทนได้ครบ เพราะมันคือ "แถวนี้ถูกแก้ล่าสุดเมื่อไหร่":
 *   · กดออก QR ใหม่ = เขียนแถว = updated_at ขยับ = token เปลี่ยน  ✓
 *   · เช็คอินสำเร็จ  = เขียนแถว = token เปลี่ยน                    ✓
 *   · เวลาเดินหน้าทางเดียว → token เก่าที่หลุดไปแล้วไม่มีวันกลับมาใช้ได้อีก ✓
 *
 * ⚠ ข้อเสียที่ต้องรู้: token ผูกกับ updated_at แปลว่า "ใครก็ตามที่เขียนแถวนี้
 *   จะทำให้ QR ที่ผู้ใช้ถืออยู่ตายทันที" ซึ่งเป็นกับดักสำหรับคนที่มาแก้ทีหลัง
 *   → แก้ด้วย syncTokenHash() ด้านล่าง: ทุกครั้งที่อ่าน QR ระบบจะตรวจว่า
 *     token_hash ในดีบีตรงกับสูตรปัจจุบันไหม ถ้าไม่ตรงก็เขียนให้ตรงเสียเลย
 *   → ผลคือ "เผลอเขียนแถว" ทำให้ QR เปลี่ยนรูป (ผู้ใช้เห็นของใหม่) แต่ระบบไม่พัง
 *   → และทำให้การเปลี่ยนสูตร v1 → v2 ครั้งนี้ "ไม่ต้องมี backfill script" เลย
 *
 * ⚠ ความปลอดภัยยังไปกองอยู่ที่ QR_TOKEN_SECRET เหมือนเดิมทุกประการ
 *   updated_at เป็นค่าที่เดาได้ (มันคือเวลา) — มันไม่ได้ทำหน้าที่ปกปิดอะไร
 *   หน้าที่ของมันคือ "ทำให้ token เปลี่ยน" เท่านั้น ส่วนที่เดาไม่ได้คือ HMAC
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
    const { validFrom, validUntil } = this.validityWindowOf(booking);

    // ★ เขียน updatedAt เองเป็น Date ของ JavaScript ไม่ปล่อยให้ดีบีใส่ now() ให้
    //   เพราะ now() ของ Postgres ละเอียดระดับไมโครวินาที แต่ JS อ่านได้แค่มิลลิวินาที
    //   → ค่าที่เขียนกับค่าที่อ่านกลับมาจะไม่เท่ากัน แล้ว token จะคำนวณไม่ตรง
    //   (ต่อให้พลาดตรงนี้ syncTokenHash() ก็ซ่อมให้อยู่ดี แต่ไม่ควรให้มันต้องซ่อมทุกแถว)
    const now = this.clock.now();

    await tx.jobSession.create({
      data: {
        id: sessionId,
        bookingId: booking.id,
        // QR ใบแรกเป็นของ "เช็คอิน" เสมอ — งานที่เพิ่งจองยังไม่มีทางเช็คเอาท์ได้
        tokenHash: this.tokenHashFor(sessionId, ScanAction.CHECK_IN, now),
        status: JOB_SESSION_STATUS.PENDING,
        validFrom,
        validUntil,
        updatedAt: now,
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
   */
  async jobQr(userId: string, bookingId: string): Promise<JobQr> {
    const session = await this.loadOwnedSession(userId, bookingId);

    // ★ ซ่อม token_hash ให้ตรงกับสูตรปัจจุบันก่อนคืนค่า (ดูคำอธิบายที่ syncTokenHash)
    //   ปกติจะไม่เขียนอะไรเลย — เขียนเฉพาะตอนที่ค่าในดีบีล้าสมัยจริง ๆ
    const synced = await this.syncTokenHash(session);

    return this.toEntity(bookingId, synced);
  }

  // ══════════════════════════════════════════════════════════════════════
  // ออก QR ใบใหม่ (GraphQL mutation: rotateJobQr) — PYG-437
  // ══════════════════════════════════════════════════════════════════════

  /**
   * ออก token ใหม่ให้ booking ใบนี้ — ใบเก่าตายทันทีที่ฟังก์ชันนี้ทำงานเสร็จ
   *
   * ใช้ตอนไหน:
   *   · QR ถูกถ่ายรูปหรือส่งต่อไปให้คนที่ไม่ควรได้ → ออกใหม่ ใบที่หลุดใช้ไม่ได้ทันที
   *   · ผู้ดูแลบอกว่าสแกนไม่ผ่านโดยไม่ทราบสาเหตุ → ออกใหม่แล้วลองอีกครั้ง
   *
   * ★ ไม่มีการจำกัดจำนวนครั้งโดยตั้งใจ
   *   กดรัว ๆ ก็ได้แค่ token ใหม่ไปเรื่อย ๆ ซึ่งไม่ทำให้ใครเสียหาย (เป็นงานของตัวเอง)
   *   ถ้าใส่ลิมิตแล้วผู้ใช้กดพลาดสองที เขาจะเจอ error ที่อธิบายยากทั้งที่ไม่ได้ทำอะไรผิด
   *   → ยอมให้เขียนดีบีเกินจำเป็นไม่กี่แถว ดีกว่าทำให้คนใช้งานสับสน
   *
   * ⚠ ผลข้างเคียงที่ผู้ใช้ต้องเข้าใจ (FE ต้องเขียนเตือนให้ชัด):
   *   ถ้าเพิ่งส่ง token เก่าให้ผู้ดูแลไปแล้ว การกดปุ่มนี้ทำให้ค่าที่ส่งไปใช้ไม่ได้
   */
  async rotateJobQr(userId: string, bookingId: string): Promise<JobQr> {
    const session = await this.loadOwnedSession(userId, bookingId);
    const action = this.nextActionOf(session.status);

    // ปิดงานไปแล้ว = ไม่เหลือ action = ออก QR ใหม่ไปก็ไม่มีใครได้ใช้
    // ตอบเป็น error ที่อ่านรู้เรื่อง ดีกว่าเขียนแถวเปล่า ๆ แล้วให้ผู้ใช้งงว่าทำไมไม่มีรูป
    if (action === null) {
      throw new BadRequestException(
        'งานนี้ปิดเรียบร้อยแล้ว จึงไม่ต้องออก QR ใหม่',
      );
    }

    const now = this.clock.now();

    const updated = await this.prisma.jobSession.update({
      where: { id: session.id },
      data: {
        // ★ updatedAt คือ "เลขรอบ" ของ token — เขียนค่าใหม่ = token เปลี่ยน
        //   สองฟิลด์นี้ต้องเขียนพร้อมกันเสมอ และต้องใช้ `now` ตัวเดียวกันเป๊ะ
        updatedAt: now,
        tokenHash: this.tokenHashFor(session.id, action, now),
      },
    });

    this.logger.log({
      event: 'job_qr.rotated',
      bookingId,
      sessionId: session.id,
      action,
    });

    return this.toEntity(bookingId, updated);
  }

  // ══════════════════════════════════════════════════════════════════════
  // เลื่อนนัด (เตรียมไว้ให้การ์ดในอนาคต)
  // ══════════════════════════════════════════════════════════════════════

  /**
   * คำนวณช่วงเวลาของ QR ใหม่ตามตารางงานล่าสุด
   *
   * ⚠ ตอนนี้ "ยังไม่มีใครเรียก method นี้" เพราะระบบยังไม่มีฟีเจอร์เลื่อนนัดเลย
   *   วางไว้ให้การ์ดเลื่อนนัดในอนาคตเรียกบรรทัดเดียวจบ
   *
   * ⚠ PYG-437: การเขียนแถวนี้ทำให้ updated_at ขยับ = token เปลี่ยนไปด้วยเสมอ
   *   จึงต้องเขียน token_hash ใหม่ในคำสั่งเดียวกัน ไม่งั้นจะมีช่วงที่ดีบีไม่ตรงกับสูตร
   *   (syncTokenHash() ซ่อมให้ตอนอ่านอยู่แล้ว แต่ไม่ควรปล่อยให้ผิดตั้งแต่แรก)
   */
  async resyncValidityWindow(bookingId: string): Promise<void> {
    const booking = await this.prisma.booking.findUnique({
      where: { id: bookingId },
      select: {
        id: true,
        bookingDate: true,
        startTime: true,
        durationHours: true,
        jobSession: { select: { id: true, status: true } },
      },
    });

    if (!booking?.jobSession) return; // ไม่มี QR ก็ไม่มีอะไรให้อัปเดต

    const { validFrom, validUntil } = this.validityWindowOf(booking);
    const now = this.clock.now();
    const action = this.nextActionOf(booking.jobSession.status);

    await this.prisma.jobSession.update({
      where: { id: booking.jobSession.id },
      data: {
        validFrom,
        validUntil,
        updatedAt: now,
        // ปิดงานแล้ว (action === null) ไม่ต้องแตะ token — ไม่มีใครสแกนต่อแล้ว
        // และการปล่อยค่าเดิมไว้ทำให้สแกนซ้ำได้ข้อความ "งานนี้ปิดแล้ว" ที่ถูกต้อง
        ...(action
          ? { tokenHash: this.tokenHashFor(booking.jobSession.id, action, now) }
          : {}),
      },
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

  /**
   * hash ของ token ที่ใช้ได้ สำหรับ (session, action, เลขรอบ) ชุดหนึ่ง
   *
   * public เพราะ PYG-435 ต้องเขียนค่านี้ลงดีบีตอนสแกนเช็คอินสำเร็จ:
   * พอสถานะขยับเป็น CHECKED_IN แล้ว token ที่ใช้ได้ต้องกลายเป็นของ CHECK_OUT ทันที
   * ถ้าไม่เขียน จะเหลือช่องให้เอา QR ของ "ตอนเริ่มงาน" ไปปิดงาน = สิ่งที่การ์ดนี้แก้พอดี
   *
   * @param revisionAt ค่าที่จะถูกเขียนลง updated_at ในคำสั่งเดียวกัน — ต้องเป็นค่าเดียวกันเป๊ะ
   */
  tokenHashFor(
    sessionId: string,
    action: TokenAction,
    revisionAt: Date,
  ): string {
    return this.hashToken(this.deriveToken(sessionId, action, revisionAt));
  }

  /**
   * สแกนครั้งต่อไปคือ action อะไร — null = ปิดงานแล้ว ไม่เหลือ action
   *
   * ★ หลักการของการ์ดแม่ PYG-433: "action ตัดสินจากสถานะ ไม่ใช่จากตัว QR"
   *   ตัว QR ยังไม่ได้บอกว่าจะทำอะไรเหมือนเดิม — แค่ตอนนี้ token ของแต่ละ action
   *   เป็นคนละค่ากันเท่านั้น (ซึ่งเป็นคนละเรื่องกับการให้ client ส่ง action มาเอง)
   */
  nextActionOf(status: string): TokenAction | null {
    if (status === JOB_SESSION_STATUS.PENDING) return ScanAction.CHECK_IN;
    if (status === JOB_SESSION_STATUS.CHECKED_IN) return ScanAction.CHECK_OUT;
    return null;
  }

  // ══════════════════════════════════════════════════════════════════════
  // ภายใน
  // ══════════════════════════════════════════════════════════════════════

  /**
   * ด่านตรวจ 4 ชั้นก่อนปล่อยให้แตะ session
   * (ใช้ร่วมกันระหว่าง jobQr กับ rotateJobQr — สองทางต้องเข้มเท่ากันเสมอ)
   *
   * ลำดับสำคัญ — อย่าสลับ:
   *   1. มี booking นี้จริงไหม
   *   2. เป็นงานของคนนี้ไหม     ← กันไม่ให้ caregiver หรือคนนอกดึง token ได้
   *   3. งานถูกยกเลิกไปแล้วหรือยัง
   *   4. มีใบ QR ไหม (booking เก่าก่อน migration จะไม่มี)
   */
  private async loadOwnedSession(
    userId: string,
    bookingId: string,
  ): Promise<SessionRow> {
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
    //   แต่สมาชิกกลุ่มคนอื่น "ยังดูไม่ได้" — ตรงตามการ์ด (เปิดง่ายกว่าปิด)
    if (booking.patientId !== userId) {
      throw new ForbiddenException('งานนี้ไม่ใช่ของคุณ');
    }

    // ─── ด่านที่ 3: งานถูกยกเลิก/ถูกปฏิเสธไปแล้วหรือยัง ───────────────
    //
    // สังเกตว่าเราไม่ได้ไปแตะ job_sessions.status ตอนยกเลิกงาน
    // แต่ตอบจาก bookings.status ตรงนี้แทน → มีความจริงชุดเดียว ไม่มีทางไม่ตรงกัน
    if (
      (QR_DEAD_BOOKING_STATUSES as readonly string[]).includes(booking.status)
    ) {
      throw new BadRequestException('งานนี้ถูกยกเลิกแล้ว QR จึงใช้ไม่ได้');
    }

    // ─── ด่านที่ 4: มีใบ QR ไหม ───────────────────────────────────────
    //
    // booking ที่สร้างก่อน migration 20260828000000 จะไม่มีแถวใน job_sessions
    if (!booking.jobSession) {
      throw new NotFoundException(
        'งานนี้ยังไม่มี QR (เป็นงานที่จองไว้ก่อนระบบ QR เปิดใช้) กรุณาติดต่อผู้ดูแลระบบ',
      );
    }

    return booking.jobSession;
  }

  /**
   * ★★ ตัวซ่อมตัวเองของระบบ token ★★
   *
   * เทียบ token_hash ในดีบีกับค่าที่สูตรปัจจุบัน "ควรจะให้" ถ้าไม่ตรงก็เขียนทับให้ตรง
   *
   * มันไม่ตรงได้ตอนไหนบ้าง:
   *   1. แถวที่ถูกสร้างด้วยสูตร v1 (ก่อน PYG-437) — คือทุกแถวที่มีอยู่ก่อนหน้านี้
   *      ★ นี่คือเหตุผลที่การเปลี่ยนสูตรครั้งนี้ "ไม่ต้องมี backfill script"
   *   2. มีโค้ดที่ไหนสักแห่งเขียนแถวนี้โดยไม่ได้เขียน token_hash ใหม่ไปด้วย
   *      (updated_at ขยับ = token เปลี่ยน — กับดักของการผูก token กับ updated_at)
   *   3. QR_TOKEN_SECRET ถูกเปลี่ยน (เครื่อง dev ที่ไม่ได้ตั้ง .env เจอทุกครั้งที่ restart)
   *
   * ⚠ นี่คือ "การเขียนดีบีในคำสั่งอ่าน" ซึ่งผิดหลักทั่วไป — ยอมรับตรงนี้โดยตั้งใจ
   *   ทางเลือกอื่นคือปล่อยให้ผู้ใช้เจอ QR ที่สแกนไม่ผ่านโดยไม่มีทางรู้ว่าทำไม
   *   ในทางปฏิบัติมันเขียนแค่ครั้งเดียวต่อแถว แล้วก็เงียบไปตลอด
   *
   * ★ ใช้ updateMany + เงื่อนไข tokenHash เดิม (compare-and-swap) ไม่ใช่ update เปล่า ๆ
   *   ถ้าผู้ใช้กด "ออก QR ใหม่" พร้อมกับที่อีกแท็บกำลังอ่านอยู่ ตัวซ่อมต้องไม่เขียนทับ
   *   ของใหม่ด้วยของเก่า — count = 0 แปลว่า "มีคนเปลี่ยนไปก่อนแล้ว" ไม่ใช่ความผิดพลาด
   */
  private async syncTokenHash(session: SessionRow): Promise<SessionRow> {
    const action = this.nextActionOf(session.status);

    // ปิดงานแล้ว = ไม่มี token ที่ "ควรจะเป็น" ให้เอาไปเทียบ
    // ★ ปล่อย token_hash ใบสุดท้ายค้างไว้โดยตั้งใจ: ผู้ดูแลที่เผลอสแกนซ้ำ
    //   จะได้ข้อความ "งานนี้ปิดเรียบร้อยแล้ว" แทน "QR นี้ใช้ไม่ได้" ซึ่งชวนสับสน
    if (action === null) return session;

    const expected = this.tokenHashFor(session.id, action, session.updatedAt);
    if (expected === session.tokenHash) return session;

    const healed = await this.prisma.jobSession.updateMany({
      where: { id: session.id, tokenHash: session.tokenHash },
      data: { tokenHash: expected },
    });

    if (healed.count === 0) {
      // แพ้การแข่ง — มีคนเขียนแถวนี้ไปก่อนแล้ว ค่าที่เราถืออยู่เก่าไปแล้ว
      // อ่านใหม่ดีกว่าเดา (ไม่ sync ซ้ำอีกรอบ เพราะรอบหน้าที่ผู้ใช้เปิดหน้าจะเก็บให้เอง)
      const fresh = await this.prisma.jobSession.findUnique({
        where: { id: session.id },
      });
      return fresh ?? session;
    }

    this.logger.log({
      event: 'job_qr.token_hash_synced',
      sessionId: session.id,
      action,
    });

    return { ...session, tokenHash: expected };
  }

  /**
   * คำนวณ token จาก (session id, action, เลขรอบ) — ดูคำอธิบายเต็มที่หัวคลาส
   *
   * base64url ไม่มีอักขระ + / = ที่ทำให้ QR reader และ URL เพี้ยน
   *
   * ★ ใส่ action ลงในสูตรด้วย ทั้งที่เลขรอบก็เปลี่ยนตอนเช็คอินอยู่แล้ว
   *   เพราะมันทำให้ "token ของคนละ action ต่างกันเสมอ" เป็นจริงจากตัวสูตรเอง
   *   ไม่ใช่จริงเพราะบังเอิญมีโค้ดอีกที่หนึ่งเขียน updated_at ให้พอดี
   *   → ถ้าวันหนึ่งมีใครลืมขยับ updated_at ตอนเช็คอิน อย่างน้อย token ก็ยังคนละใบ
   */
  private deriveToken(
    sessionId: string,
    action: TokenAction,
    revisionAt: Date,
  ): string {
    const message = `${QR_TOKEN_DOMAIN}:${sessionId}:${action}:${revisionAt.getTime()}`;
    return createHmac('sha256', this.secret)
      .update(message, 'utf8')
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
    // ปกติเป็นจริงอยู่แล้ว แต่ถ้าวันหนึ่งมีใครตั้ง QR_VALID_UNTIL_GRACE_MIN เป็นค่าติดลบ
    // การสร้าง booking จะพังทั้งระบบเพราะ INSERT ไม่ผ่าน
    // — ยอมขยับเวลาให้ ดีกว่าจองไม่ได้เลย
    if (validUntil <= validFrom) {
      validUntil = new Date(validFrom.getTime() + 60_000);
    }

    return { validFrom, validUntil };
  }

  /** แถวในดีบี → ก้อนข้อมูลที่ส่งให้ FE (เติม token + ค่าที่คำนวณตอนอ่าน) */
  private toEntity(bookingId: string, session: SessionRow): JobQr {
    const now = this.clock.now();
    const nextAction = this.nextActionOf(session.status);

    return {
      bookingId,
      // ★ ปิดงานแล้วไม่มี token ให้แสดง — ส่งสตริงว่างแทน
      //   (schema ประกาศเป็น non-null และ FE ไม่วาด QR อยู่แล้วเมื่อ isActive = false)
      //   ห้ามส่ง token ใบสุดท้ายกลับไป: งานปิดแล้วไม่มีเหตุผลให้ค่าลับยังลอยอยู่บนจอ
      token: nextAction
        ? this.deriveToken(session.id, nextAction, session.updatedAt)
        : '',
      // PYG-436: แปลงเป็น enum ตรงนี้ที่เดียว — Prisma คืน status มาเป็น string
      status: toJobSessionStatus(session.status),
      validFrom: session.validFrom,
      validUntil: session.validUntil,
      isActive:
        nextAction !== null &&
        now >= session.validFrom &&
        now <= session.validUntil,
      nextAction: nextAction ?? undefined,
      // PYG-437: "QR ชุดที่เห็นอยู่นี้ออกเมื่อไหร่" — ก็คือเลขรอบที่ใช้คำนวณ token นั่นเอง
      // FE เอาไปโชว์ให้ผู้ใช้มั่นใจว่าปุ่ม "ออก QR ใหม่" ทำงานจริง
      // (ตัว QR เปลี่ยนลายนิดเดียว มองด้วยตาเปล่าแทบไม่ออก)
      tokenIssuedAt: session.updatedAt,
    };
  }

  /**
   * หากุญแจลับตอนแอปบูต
   *
   * ★ production: ไม่มีกุญแจ = แอปไม่ยอมบูต (ตั้งใจให้พังเสียงดัง)
   * ★ dev/test: ไม่มีกุญแจ = สุ่มให้ 1 ชุดต่อการรันหนึ่งครั้ง + เตือนดัง ๆ
   *   (PYG-437: syncTokenHash() จะซ่อม token_hash ให้เองตอนเปิดหน้า QR
   *    ทำให้เครื่อง dev ที่ไม่ได้ตั้ง .env ยังทดสอบได้ปกติแม้จะ restart บ่อย)
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
