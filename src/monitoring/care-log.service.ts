import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
  UnprocessableEntityException,
  UnsupportedMediaTypeException,
} from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { randomUUID } from 'crypto';
import { PrismaService } from '../common/prisma.service';
import { ClockService } from '../common/clock.service';
import { SupabaseService } from '../common/supabase.service';
import { AddCareLogInput } from './dto/add-care-log.input';
import { CreateCareLogDto } from './dto/create-care-log.dto';
import { CareLog } from './entities/care-log.entity';
import {
  BOOKING_STATUS,
  CARE_LOG_IMAGES_BUCKET,
  CARE_LOG_PHOTO_MIME,
  CLOCK_ANOMALY_TOLERANCE_MIN,
  EARLY_GRACE_MIN,
  JOB_EVENT_TYPE,
  JOB_EVIDENCE_BUCKET,
  SIGNED_URL_TTL_SEC,
} from './monitoring.constants';
import { scheduledStartOf } from './booking-schedule.util';
import {
  hasJpegSignature,
  InvalidJpegError,
  stripJpegApp1,
} from './care-log-photo.util';
import { BOOKING_EVENTS } from '../notification/events/booking-event';

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

type CareLogRow = {
  id: string;
  booking_id: string;
  category: string;
  body: string;
  photo_url: string | null;
  photo_bucket: string | null;
  server_ts: Date;
  device_ts: Date | null;
};

/** ไฟล์จาก FileInterceptor — ใช้แค่ field ที่จำเป็น */
type UploadedPhoto = Pick<Express.Multer.File, 'buffer' | 'mimetype'>;

/**
 * CareLogService — "บันทึกจากผู้ดูแล" ระหว่างปฏิบัติงาน (PYG-361)
 *
 * ★ SCOPE BOUNDARY: จำนวน/เนื้อหาของ care log ต้องไม่มีผลต่อ proofOfWork.verdict หรือ
 *   review_reasons หรือการปล่อยเงินเลยแม้แต่นิดเดียว — เป็น display-only ล้วน ๆ
 * ★ ห้ามแก้ไข/ลบรายการที่โพสต์ไปแล้ว (audit trail ของการดูแลผู้ป่วย) — service นี้จึงมีแค่
 *   "อ่าน" กับ "เพิ่ม" เท่านั้น ไม่มี update/delete
 *
 * PYG-466: รูปอัปโหลดผ่าน backend (createCareLog) เข้า bucket care-log-images
 *   addCareLog (GraphQL) deprecated — รับเฉพาะข้อความ ส่ง photoUrl มา = 400
 *   แถวเก่ามีรูปใน job-evidence → care_logs.photo_bucket บอกว่าต้อง sign จาก bucket ไหน
 */
@Injectable()
export class CareLogService {
  private readonly logger = new Logger(CareLogService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly clock: ClockService,
    private readonly supabaseService: SupabaseService,
    private readonly eventEmitter: EventEmitter2,
  ) {}

  /**
   * PYG-466: ผู้ดูแลบันทึก 1 รายการ พร้อมรูป (ไม่บังคับ) — POST /api/v1/monitoring/bookings/:bookingId/care-logs
   *
   * ลำดับ: ตรวจสิทธิ์ booking → deviceTs → ไฟล์ → อัปโหลด → insert
   *   upload ล้ม → ไม่มีแถวเกิดขึ้น
   *   insert ล้ม → ลบไฟล์ที่เพิ่งอัปโหลด แล้ว throw error ของ insert เสมอ (ลบไม่สำเร็จ = log care_log.orphan_file)
   *
   * @param userId  users.id จาก JWT (ปลอม caregiverId ผ่าน input ไม่ได้)
   */
  async createCareLog(
    userId: string,
    bookingId: string,
    dto: CreateCareLogDto,
    photo?: UploadedPhoto,
  ): Promise<CareLog> {
    const caregiver = await this.prisma.caregiver.findUnique({
      where: { userId },
      select: { id: true },
    });
    if (!caregiver) {
      throw new ForbiddenException('ไม่พบโปรไฟล์ผู้ดูแลของบัญชีนี้');
    }

    // เวลาเช็คอินจริงมาพร้อม query ตรวจสิทธิ์เลย ไม่เพิ่ม round trip
    const booking = await this.prisma.booking.findUnique({
      where: { id: bookingId },
      select: {
        id: true,
        caregiverId: true,
        status: true,
        patientId: true,
        bookingDate: true,
        startTime: true,
        jobEvents: {
          where: { eventType: JOB_EVENT_TYPE.CHECK_IN },
          orderBy: { serverTs: 'desc' },
          take: 1,
          select: { serverTs: true },
        },
      },
    });

    // ─── ด่านที่ 1: มีงานนี้จริงไหม ─────────────────────────────────
    if (!booking) {
      throw new NotFoundException('ไม่พบงานนี้');
    }

    // ─── ด่านที่ 2: เป็นงานของ caregiver คนนี้ไหม ────────────────────
    if (booking.caregiverId !== caregiver.id) {
      throw new ForbiddenException('งานนี้ไม่ใช่ของคุณ');
    }

    // ─── ด่านที่ 3: สถานะงาน — business rule จึงเป็น 422 (addCareLog เดิมคง 400 ไว้ ไม่แตะ) ──
    if (booking.status !== BOOKING_STATUS.IN_PROGRESS) {
      throw new UnprocessableEntityException('ต้องเช็คอินก่อนจึงจะบันทึกได้');
    }

    const now = this.clock.now();
    const deviceTs = this.assertDeviceTsInWindow(dto.deviceTs, now, booking);

    const photoBytes = photo ? this.preparePhoto(photo) : null;
    const photoPath = photoBytes
      ? `${booking.id}/care-log-${randomUUID()}.jpg`
      : null;

    if (photoBytes && photoPath) {
      await this.uploadPhoto(photoPath, photoBytes, booking.id);
    }

    let created: CareLogRow;
    try {
      created = await this.prisma.care_logs.create({
        data: {
          booking_id: booking.id,
          caregiver_id: caregiver.id,
          category: dto.category,
          body: dto.body,
          photo_url: photoPath,
          photo_bucket: photoPath ? CARE_LOG_IMAGES_BUCKET : null,
          server_ts: now,
          device_ts: deviceTs,
        },
      });
    } catch (insertError) {
      if (photoPath) {
        await this.removeOrphanPhoto(photoPath, booking.id);
      }
      throw insertError;
    }

    this.logger.log({
      event: 'care_log.added',
      bookingId: booking.id,
      caregiverId: caregiver.id,
      category: dto.category,
      hasPhoto: photoPath !== null,
    });

    await this.notifyIfFirstLog(booking, userId, dto.category);

    return this.toEntity(created, await this.signPhoto(created));
  }

  /**
   * ผู้ดูแลบันทึก 1 รายการระหว่างงาน
   * @deprecated PYG-466 — ใช้ createCareLog (REST) แทน; ไม่รับ photoUrl แล้ว
   * @param userId  users.id จาก JWT (ปลอม caregiverId ผ่าน input ไม่ได้)
   */
  async addCareLog(userId: string, input: AddCareLogInput): Promise<CareLog> {
    const caregiver = await this.prisma.caregiver.findUnique({
      where: { userId },
      select: { id: true },
    });
    if (!caregiver) {
      throw new ForbiddenException('ไม่พบโปรไฟล์ผู้ดูแลของบัญชีนี้');
    }

    const booking = await this.prisma.booking.findUnique({
      where: { id: input.bookingId },
      select: { id: true, caregiverId: true, status: true, patientId: true },
    });

    // ─── ด่านที่ 1: มีงานนี้จริงไหม ─────────────────────────────────
    if (!booking) {
      throw new NotFoundException('ไม่พบงานนี้');
    }

    // ─── ด่านที่ 2: เป็นงานของ caregiver คนนี้ไหม ────────────────────
    if (booking.caregiverId !== caregiver.id) {
      throw new ForbiddenException('งานนี้ไม่ใช่ของคุณ');
    }

    // ─── ด่านที่ 3: สถานะงาน — ต้องเช็คอินอยู่เท่านั้น ────────────────
    if (booking.status !== BOOKING_STATUS.IN_PROGRESS) {
      throw new BadRequestException('ต้องเช็คอินก่อนจึงจะบันทึกได้');
    }

    // ─── PYG-466: ห้ามเขียนรูป care log ใหม่ลง job-evidence ──────────────
    // ตำแหน่งเดียวกับที่เคยตรวจ path เดิม → ลำดับ error ของ client เก่าไม่เปลี่ยน
    if (input.photoUrl) {
      throw new BadRequestException(
        'mutation นี้ไม่รับรูปแล้ว — แนบรูปผ่าน POST /api/v1/monitoring/bookings/:bookingId/care-logs',
      );
    }

    const now = this.clock.now();
    const deviceTs = input.deviceTs ? new Date(input.deviceTs) : null;

    const created = await this.prisma.care_logs.create({
      data: {
        booking_id: booking.id,
        caregiver_id: caregiver.id,
        category: input.category,
        body: input.body,
        photo_url: null,
        photo_bucket: null,
        server_ts: now,
        device_ts: deviceTs,
      },
    });

    this.logger.log({
      event: 'care_log.added',
      bookingId: booking.id,
      caregiverId: caregiver.id,
      category: input.category,
      hasPhoto: false,
    });

    await this.notifyIfFirstLog(booking, userId, input.category);

    return this.toEntity(created, undefined);
  }

  /**
   * รายการบันทึกทั้งหมดของ booking หนึ่งใบ เรียงใหม่→เก่า
   * เปิดให้: ผู้รับบริการเจ้าของงาน / ผู้ดูแลเจ้าของงาน / แอดมิน (เหมือน proofOfWork)
   */
  async careLogs(
    userId: string,
    role: number,
    bookingId: string,
    limit?: number,
    offset?: number,
  ): Promise<CareLog[]> {
    const booking = await this.prisma.booking.findUnique({
      where: { id: bookingId },
      include: { caregiver: { select: { userId: true } } },
    });

    if (!booking) {
      throw new NotFoundException('ไม่พบงานนี้');
    }

    // แอดมิน (3) ดูได้ทุกงาน; คนอื่นต้องเป็นคู่กรณีของงานนั้นเท่านั้น (เหมือน proofOfWork)
    const isAdmin = role === 3;
    const isParticipant =
      booking.patientId === userId || booking.caregiver?.userId === userId;

    if (!isAdmin && !isParticipant) {
      throw new ForbiddenException('คุณไม่มีสิทธิ์ดูข้อมูลงานนี้');
    }

    const take = Math.min(MAX_LIMIT, Math.max(1, limit ?? DEFAULT_LIMIT));
    const skip = Math.max(0, offset ?? 0);

    const rows = await this.prisma.care_logs.findMany({
      where: { booking_id: bookingId },
      orderBy: { server_ts: 'desc' },
      take,
      skip,
    });

    return Promise.all(
      rows.map(async (row) => this.toEntity(row, await this.signPhoto(row))),
    );
  }

  /**
   * deviceTs ต้องอยู่ใน [เวลาเช็คอินจริง − tolerance, now + tolerance] ไม่งั้น 422
   *
   * ขอบล่างใช้ server_ts ของ check_in เท่านั้น (ห้ามใช้ device_ts ของ check_in — นาฬิกาเครื่องเพี้ยนจะลากขอบตาม)
   * ไม่ผูกกับเวลานัด เพราะเช็คอินก่อนเวลานัดได้ (EARLY_GRACE_MIN) และบันทึกเกิดก่อนเริ่มงานจริงไม่ได้
   *
   * ไม่พบแถว check_in ทั้งที่ in_progress = ข้อมูลผิดปกติ → fallback จากเวลานัด + log ห้าม throw
   */
  private assertDeviceTsInWindow(
    raw: string,
    now: Date,
    booking: {
      id: string;
      bookingDate: Date;
      startTime: Date | null;
      jobEvents: { serverTs: Date }[];
    },
  ): Date {
    const deviceTs = new Date(raw);
    if (Number.isNaN(deviceTs.getTime())) {
      throw new BadRequestException('deviceTs ต้องเป็นเวลา ISO 8601');
    }

    const toleranceMs = CLOCK_ANOMALY_TOLERANCE_MIN * 60_000;
    const checkIn = booking.jobEvents[0];

    let lower: Date;
    if (checkIn) {
      lower = new Date(checkIn.serverTs.getTime() - toleranceMs);
    } else {
      this.logger.warn({
        event: 'care_log.missing_check_in_event',
        bookingId: booking.id,
      });
      const scheduledStart = scheduledStartOf(
        booking.bookingDate,
        booking.startTime,
      );
      lower = new Date(
        scheduledStart.getTime() - EARLY_GRACE_MIN * 60_000 - toleranceMs,
      );
    }
    const upper = new Date(now.getTime() + toleranceMs);

    if (deviceTs < lower || deviceTs > upper) {
      throw new UnprocessableEntityException(
        `deviceTs อยู่นอกช่วงที่ยอมรับ — ต้องอยู่ระหว่าง ${lower.toISOString()} ถึง ${upper.toISOString()}`,
      );
    }
    return deviceTs;
  }

  /** ตรวจไฟล์จาก byte จริง แล้วตัด Exif/XMP ทิ้ง — คืน buffer ที่จะอัปโหลด */
  private preparePhoto(photo: UploadedPhoto): Buffer {
    if (photo.mimetype !== CARE_LOG_PHOTO_MIME) {
      throw new UnsupportedMediaTypeException('รองรับเฉพาะรูป JPEG');
    }
    if (!photo.buffer || photo.buffer.length === 0) {
      throw new BadRequestException('ไฟล์รูปว่างเปล่า');
    }
    // MIME มาจาก client ปลอมได้ — signature จาก buffer คือด่านจริง
    if (!hasJpegSignature(photo.buffer)) {
      throw new UnsupportedMediaTypeException('ไฟล์ไม่ใช่รูป JPEG');
    }
    try {
      return stripJpegApp1(photo.buffer);
    } catch (err) {
      if (err instanceof InvalidJpegError) {
        throw new UnsupportedMediaTypeException('ไฟล์ JPEG เสียหาย');
      }
      throw err;
    }
  }

  private async uploadPhoto(
    path: string,
    bytes: Buffer,
    bookingId: string,
  ): Promise<void> {
    const { error } = await this.supabaseService
      .getAdminClient()
      .storage.from(CARE_LOG_IMAGES_BUCKET)
      .upload(path, bytes, { contentType: CARE_LOG_PHOTO_MIME, upsert: false });

    if (error) {
      this.logger.error({
        event: 'care_log.upload_failed',
        bucket: CARE_LOG_IMAGES_BUCKET,
        path,
        bookingId,
        reason: error.message,
      });
      throw new InternalServerErrorException(
        'อัปโหลดรูปไม่สำเร็จ กรุณาลองใหม่',
      );
    }
  }

  /** ลบไฟล์ที่ insert ไม่สำเร็จ — ห้าม throw เด็ดขาด (client ต้องได้ error ของ insert ไม่ใช่ของ cleanup) */
  private async removeOrphanPhoto(
    path: string,
    bookingId: string,
  ): Promise<void> {
    let reason: string;
    try {
      const { error } = await this.supabaseService
        .getAdminClient()
        .storage.from(CARE_LOG_IMAGES_BUCKET)
        .remove([path]);
      if (!error) return;
      reason = error.message;
    } catch (err) {
      reason = err instanceof Error ? err.message : String(err);
    }

    this.logger.error({
      event: 'care_log.orphan_file',
      bucket: CARE_LOG_IMAGES_BUCKET,
      path,
      bookingId,
      reason,
    });
  }

  private async notifyIfFirstLog(
    booking: { id: string; patientId: string },
    userId: string,
    category: string,
  ): Promise<void> {
    // PO ตัดสินใจแล้ว (2026-09-06): แจ้งเตือนเฉพาะ "รายการแรก" ของแต่ละงานเท่านั้น
    // งาน 8 ชม. อาจมี 10 รายการ — ถ้าแจ้งทุกครั้งผู้ใช้จะปิดแจ้งเตือนทั้งแอป
    // นับหลัง insert แถวนี้แล้ว: ถ้ามีแถวเดียว (แถวที่เพิ่งสร้าง) แปลว่านี่คือรายการแรกจริง ๆ
    const totalForBooking = await this.prisma.care_logs.count({
      where: { booking_id: booking.id },
    });
    if (totalForBooking === 1) {
      // fire-and-forget เหมือน booking event อื่น ๆ
      this.eventEmitter.emit(BOOKING_EVENTS.JOB_CARE_LOG_ADDED, {
        bookingId: booking.id,
        eventType: BOOKING_EVENTS.JOB_CARE_LOG_ADDED,
        patientId: booking.patientId,
        caregiverId: userId,
        metadata: { category },
      });
    }
  }

  /**
   * signed URL ของรูปประกอบ — bucket มาจาก photo_bucket (NULL = แถวเก่า → job-evidence)
   *
   * ใช้ admin client (service-role) ทั้งสอง bucket: care-log-images ไม่มี select policy ให้ใครเลย
   * ⚠ ไม่เรียก JobEvidenceService.sign() — ตัวนั้นใช้ anon key (บั๊กแยกการ์ด อย่าแก้ที่นี่)
   */
  private async signPhoto(row: CareLogRow): Promise<string | undefined> {
    if (!row.photo_url) return undefined;
    const bucket = row.photo_bucket ?? JOB_EVIDENCE_BUCKET;

    const { data, error } = await this.supabaseService
      .getAdminClient()
      .storage.from(bucket)
      .createSignedUrl(row.photo_url, SIGNED_URL_TTL_SEC);

    if (error || !data?.signedUrl) {
      this.logger.warn({
        event: 'care_log.sign_url_failed',
        bucket,
        path: row.photo_url,
      });
      return undefined;
    }
    return data.signedUrl;
  }

  private toEntity(row: CareLogRow, signedPhotoUrl: string | undefined): CareLog {
    return {
      id: row.id,
      bookingId: row.booking_id,
      category: row.category,
      body: row.body,
      photoUrl: signedPhotoUrl,
      serverTs: row.server_ts,
      deviceTs: row.device_ts ?? undefined,
    };
  }
}
