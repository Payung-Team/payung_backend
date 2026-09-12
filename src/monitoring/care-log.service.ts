import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { PrismaService } from '../common/prisma.service';
import { ClockService } from '../common/clock.service';
import { JobEvidenceService } from './job-evidence.service';
import { AddCareLogInput } from './dto/add-care-log.input';
import { CareLog } from './entities/care-log.entity';
import { BOOKING_STATUS } from './monitoring.constants';
import { BOOKING_EVENTS } from '../notification/events/booking-event';

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

type CareLogRow = {
  id: string;
  booking_id: string;
  category: string;
  body: string;
  photo_url: string | null;
  server_ts: Date;
  device_ts: Date | null;
};

/**
 * CareLogService — "บันทึกจากผู้ดูแล" ระหว่างปฏิบัติงาน (PYG-361)
 *
 * ★ SCOPE BOUNDARY: จำนวน/เนื้อหาของ care log ต้องไม่มีผลต่อ proofOfWork.verdict หรือ
 *   review_reasons หรือการปล่อยเงินเลยแม้แต่นิดเดียว — เป็น display-only ล้วน ๆ
 * ★ ห้ามแก้ไข/ลบรายการที่โพสต์ไปแล้ว (audit trail ของการดูแลผู้ป่วย) — service นี้จึงมีแค่
 *   "อ่าน" กับ "เพิ่ม" เท่านั้น ไม่มี update/delete
 */
@Injectable()
export class CareLogService {
  private readonly logger = new Logger(CareLogService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly clock: ClockService,
    private readonly jobEvidenceService: JobEvidenceService,
    private readonly eventEmitter: EventEmitter2,
  ) {}

  /**
   * ผู้ดูแลบันทึก 1 รายการระหว่างงาน
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

    // ─── ตรวจไฟล์แนบ (กฎเดียวกับ checkOutBooking — ใช้ JobEvidenceService ตัวเดียวกัน) ──
    const photoPath = this.jobEvidenceService.validatePath(input.photoUrl, booking.id);

    const now = this.clock.now();
    const deviceTs = input.deviceTs ? new Date(input.deviceTs) : null;

    const created = await this.prisma.care_logs.create({
      data: {
        booking_id: booking.id,
        caregiver_id: caregiver.id,
        category: input.category,
        body: input.body,
        photo_url: photoPath,
        server_ts: now,
        device_ts: deviceTs,
      },
    });

    this.logger.log({
      event: 'care_log.added',
      bookingId: booking.id,
      caregiverId: caregiver.id,
      category: input.category,
      hasPhoto: photoPath !== null,
    });

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
        metadata: { category: input.category },
      });
    }

    return this.toEntity(created, await this.signPhoto(photoPath));
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
      rows.map(async (row) => this.toEntity(row, await this.signPhoto(row.photo_url))),
    );
  }

  private async signPhoto(path: string | null): Promise<string | undefined> {
    if (!path) return undefined;
    const signed = await this.jobEvidenceService.sign(path);
    return signed ?? undefined;
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
