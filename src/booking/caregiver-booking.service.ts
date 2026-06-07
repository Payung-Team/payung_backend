import {
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { PrismaService } from '../common/prisma.service';
import {
  CaregiverBookingListResponse,
  CaregiverBookingSummary,
  RepeatPatientDto,
  RepeatPatientListResponse,
} from './dto/caregiver-booking.types';
import { BookingPagination } from './dto/booking-summary.types';
import { CaregiverBookingsInput } from './dto/caregiver-bookings.input';
import { CaregiverBookingHistoryInput } from './dto/caregiver-booking-history.input';
import { DeclineBookingInput } from './dto/decline-booking.input';
import { CancelAcceptanceInput } from './dto/cancel-acceptance.input';

/**
 * รูปทรงของ booking ที่ดึงมาพร้อม relation (patient + careRecipient)
 * ประกาศเป็น structural type เอง เพื่อไม่ผูกกับ type ที่ Prisma generate โดยตรง
 * (แนวเดียวกับ BookingWithIncludes ใน booking.service.ts ฝั่ง patient)
 */
type CaregiverBookingRow = {
  id: string;
  status: string;
  serviceType: string;
  serviceLocations: string[];
  timeSlot: string;
  bookingDate: Date;
  startTime: Date;
  durationHours: { toNumber(): number } | number;
  locationAddress: string;
  estimatedCost: { toNumber(): number } | number | null;
  acceptedAt: Date | null;
  confirmedAt: Date | null;
  rejectionReason: string | null;
  createdAt: Date;
  patient: { id: string; displayName: string | null; avatarUrl: string | null };
  careRecipient: { name: string } | null;
};

/**
 * include ที่ใช้ซ้ำทุกครั้งที่ต้อง map เป็น CaregiverBookingSummary
 * - patient: ข้อมูลลูกค้าแบบย่อ (ฝั่ง caregiver ต้องเห็น patient ไม่ใช่ caregiver)
 * - careRecipient: ชื่อผู้รับการดูแล (อาจเป็น null = จองให้ตัวเอง)
 */
const BOOKING_INCLUDE = {
  patient: { select: { id: true, displayName: true, avatarUrl: true } },
  careRecipient: { select: { name: true } },
} as const;

@Injectable()
export class CaregiverBookingService {
  private readonly logger = new Logger(CaregiverBookingService.name);

  constructor(private readonly prisma: PrismaService) {}

  // ════════════════════════════════════════════════════════════════════════
  //  QUERIES (อ่านข้อมูล)
  // ════════════════════════════════════════════════════════════════════════

  /**
   * รายการ booking ของ caregiver ตามสถานะ (ticket #1, #2, #5)
   *
   * - status=pending   → คำขอใหม่ (เรียงใหม่→เก่า เพื่อโชว์ "ได้รับเมื่อ X ที่แล้ว")
   * - status=accepted  → รอผู้ป่วยยืนยัน (เรียงตามวันนัด ใกล้→ไกล)
   * - status=confirmed (+ upcoming=true) → งานในกำหนดเวลา / active jobs
   */
  async caregiverBookings(
    userId: string,
    input: CaregiverBookingsInput,
  ): Promise<CaregiverBookingListResponse> {
    const caregiverId = await this.resolveCaregiverId(userId);
    const { page, limit, offset } = this.normalizePaging(input.page, input.limit);

    // where: เฉพาะงานของ caregiver คนนี้ + สถานะที่ขอ
    const where: Record<string, unknown> = { caregiverId, status: input.status };

    // upcoming=true → เอาเฉพาะงานตั้งแต่วันนี้เป็นต้นไป (ใช้กับ active jobs)
    if (input.upcoming) {
      where.bookingDate = { gte: this.startOfTodayUtc() };
    }

    const [items, total] = await Promise.all([
      this.prisma.booking.findMany({
        where,
        include: BOOKING_INCLUDE,
        orderBy: this.orderByForStatus(input.status),
        skip: offset,
        take: limit,
      }),
      this.prisma.booking.count({ where }),
    ]);

    return this.toListResponse(items as unknown as CaregiverBookingRow[], {
      page,
      limit,
      total,
    });
  }

  /**
   * ประวัติงานทั้งหมดของ caregiver (ticket #7)
   * filter ได้ตามสถานะ + ช่วงวันที่ (booking_date), เรียงใหม่→เก่า
   */
  async caregiverBookingHistory(
    userId: string,
    input: CaregiverBookingHistoryInput,
  ): Promise<CaregiverBookingListResponse> {
    const caregiverId = await this.resolveCaregiverId(userId);
    const { page, limit, offset } = this.normalizePaging(input.page, input.limit);

    const where: Record<string, unknown> = { caregiverId };
    if (input.status) where.status = input.status;

    // ช่วงวันที่: ประกอบ gte/lte เฉพาะตัวที่ส่งมา
    if (input.dateFrom || input.dateTo) {
      where.bookingDate = {
        ...(input.dateFrom ? { gte: new Date(input.dateFrom) } : {}),
        ...(input.dateTo ? { lte: new Date(input.dateTo) } : {}),
      };
    }

    const [items, total] = await Promise.all([
      this.prisma.booking.findMany({
        where,
        include: BOOKING_INCLUDE,
        orderBy: { createdAt: 'desc' },
        skip: offset,
        take: limit,
      }),
      this.prisma.booking.count({ where }),
    ]);

    return this.toListResponse(items as unknown as CaregiverBookingRow[], {
      page,
      limit,
      total,
    });
  }

  /**
   * ลูกค้าประจำ — patient ที่มีงาน "เสร็จสิ้น" กับ caregiver คนนี้ >= 2 ครั้ง (ticket #6)
   *
   * วิธีคิด: groupBy patientId นับเฉพาะ status=completed แล้วกรอง having >= 2
   * pagination ทำใน memory เพราะจำนวนลูกค้าประจำต่อ caregiver มักไม่เยอะ
   * (ถ้าโตมากค่อยย้าย logic นี้ไปทำใน SQL ภายหลัง)
   */
  async caregiverRepeatPatients(
    userId: string,
    page = 1,
    limit = 10,
  ): Promise<RepeatPatientListResponse> {
    const caregiverId = await this.resolveCaregiverId(userId);
    const { page: p, limit: l, offset } = this.normalizePaging(page, limit);

    const groups = await this.prisma.booking.groupBy({
      by: ['patientId'],
      where: { caregiverId, status: 'completed' },
      _count: { id: true }, // นับจำนวน booking ต่อ patient
      _max: { bookingDate: true }, // วันงานล่าสุด
      having: { id: { _count: { gte: 2 } } }, // เอาเฉพาะที่ทำซ้ำ >= 2 ครั้ง
    });

    // groupBy ไม่การันตีลำดับ → เรียงเองตามวันล่าสุด (ใหม่→เก่า)
    groups.sort((a, b) => {
      const ta = a._max.bookingDate ? new Date(a._max.bookingDate).getTime() : 0;
      const tb = b._max.bookingDate ? new Date(b._max.bookingDate).getTime() : 0;
      return tb - ta;
    });

    const total = groups.length;
    const pageGroups = groups.slice(offset, offset + l);

    // ดึง user ของ patient เฉพาะหน้าปัจจุบัน (query เดียว) แล้วทำ map ไว้ lookup
    const patientIds = pageGroups.map((g) => g.patientId);
    const users = patientIds.length
      ? await this.prisma.user.findMany({
          where: { id: { in: patientIds } },
          select: { id: true, displayName: true, avatarUrl: true },
        })
      : [];
    const userMap = new Map(users.map((u) => [u.id, u]));

    const data: RepeatPatientDto[] = pageGroups.map((g) => {
      const u = userMap.get(g.patientId);
      return {
        patientId: g.patientId,
        displayName: u?.displayName ?? undefined,
        avatarUrl: u?.avatarUrl ?? undefined,
        completedCount: g._count.id,
        lastCompletedAt: g._max.bookingDate ?? undefined,
      };
    });

    const pagination: BookingPagination = {
      page: p,
      limit: l,
      total,
      totalPages: total === 0 ? 1 : Math.ceil(total / l),
    };
    return { data, pagination };
  }

  // ════════════════════════════════════════════════════════════════════════
  //  MUTATIONS (เปลี่ยนสถานะ)
  // ════════════════════════════════════════════════════════════════════════

  /**
   * caregiver กดรับงาน (ticket #3): pending → accepted (+ บันทึก acceptedAt)
   * Guard: ต้องเป็น caregiver ที่ถูก assign กับ booking นี้เท่านั้น
   */
  async acceptBooking(
    userId: string,
    bookingId: string,
  ): Promise<CaregiverBookingSummary> {
    const caregiverId = await this.resolveCaregiverId(userId);
    const existing = await this.loadOwnedBooking(caregiverId, bookingId);

    if (existing.status !== 'pending') {
      throw new UnprocessableEntityException(
        'Only bookings with status "pending" can be accepted',
      );
    }

    const updated = await this.prisma.booking.update({
      where: { id: bookingId },
      data: { status: 'accepted', acceptedAt: new Date() },
      include: BOOKING_INCLUDE,
    });

    this.logger.log({ event: 'booking.accepted', bookingId, userId });
    return this.toSummary(updated as unknown as CaregiverBookingRow);
  }

  /**
   * caregiver ปฏิเสธคำขอ (ticket #4): pending → rejected (+ เหตุผลบังคับ)
   */
  async declineBooking(
    userId: string,
    input: DeclineBookingInput,
  ): Promise<CaregiverBookingSummary> {
    const caregiverId = await this.resolveCaregiverId(userId);
    const existing = await this.loadOwnedBooking(caregiverId, input.bookingId);

    if (existing.status !== 'pending') {
      throw new UnprocessableEntityException(
        'Only bookings with status "pending" can be declined',
      );
    }

    const updated = await this.prisma.booking.update({
      where: { id: input.bookingId },
      data: { status: 'rejected', rejectionReason: input.reason.trim() },
      include: BOOKING_INCLUDE,
    });

    this.logger.log({ event: 'booking.declined', bookingId: input.bookingId, userId });
    return this.toSummary(updated as unknown as CaregiverBookingRow);
  }

  /**
   * caregiver ยกเลิกการรับงานก่อน patient ยืนยัน (undoc #10):
   * accepted → rejected (+ เหตุผลบังคับ)
   * เก็บ acceptedAt เดิมไว้เพื่อเป็น audit trail (ว่าเคยรับแล้วถอน)
   */
  async cancelAcceptance(
    userId: string,
    input: CancelAcceptanceInput,
  ): Promise<CaregiverBookingSummary> {
    const caregiverId = await this.resolveCaregiverId(userId);
    const existing = await this.loadOwnedBooking(caregiverId, input.bookingId);

    if (existing.status !== 'accepted') {
      throw new UnprocessableEntityException(
        'Only bookings with status "accepted" can have their acceptance cancelled',
      );
    }

    const updated = await this.prisma.booking.update({
      where: { id: input.bookingId },
      data: { status: 'rejected', rejectionReason: input.reason.trim() },
      include: BOOKING_INCLUDE,
    });

    this.logger.log({
      event: 'booking.acceptance_cancelled',
      bookingId: input.bookingId,
      userId,
    });
    return this.toSummary(updated as unknown as CaregiverBookingRow);
  }

  // ════════════════════════════════════════════════════════════════════════
  //  PRIVATE HELPERS
  // ════════════════════════════════════════════════════════════════════════

  /**
   * หา caregiver.id จาก user.id (จาก JWT)
   * RolesGuard การันตีว่า role=CAREGIVER แล้ว แต่ยังเช็คซ้ำเผื่อยังไม่มี profile
   * (defense in depth)
   */
  private async resolveCaregiverId(userId: string): Promise<string> {
    const caregiver = await this.prisma.caregiver.findUnique({
      where: { userId },
      select: { id: true },
    });
    if (!caregiver) {
      throw new ForbiddenException('Caregiver profile not found');
    }
    return caregiver.id;
  }

  /**
   * โหลด booking พร้อมตรวจสิทธิ์ว่าเป็นของ caregiver คนนี้จริง
   * @throws NotFoundException  ถ้าไม่พบ booking
   * @throws ForbiddenException ถ้า booking ไม่ใช่ของ caregiver คนนี้
   */
  private async loadOwnedBooking(
    caregiverId: string,
    bookingId: string,
  ): Promise<{ id: string; status: string }> {
    const existing = await this.prisma.booking.findUnique({
      where: { id: bookingId },
      select: { id: true, caregiverId: true, status: true },
    });

    if (!existing) {
      throw new NotFoundException('Booking not found');
    }
    if (existing.caregiverId !== caregiverId) {
      throw new ForbiddenException('Access denied');
    }
    return { id: existing.id, status: existing.status };
  }

  /** แปลง page/limit จาก client ให้อยู่ในขอบเขตที่ปลอดภัย (1..50) + คำนวณ offset */
  private normalizePaging(
    page?: number,
    limit?: number,
  ): { page: number; limit: number; offset: number } {
    const p = Math.max(1, page ?? 1);
    const l = Math.min(50, Math.max(1, limit ?? 10));
    return { page: p, limit: l, offset: (p - 1) * l };
  }

  /** เลือกการเรียงลำดับให้เหมาะกับแต่ละสถานะ */
  private orderByForStatus(status: string): Record<string, 'asc' | 'desc'> {
    switch (status) {
      case 'pending':
        return { createdAt: 'desc' }; // คำขอใหม่ล่าสุดอยู่บนสุด
      case 'accepted':
      case 'confirmed':
        return { bookingDate: 'asc' }; // ใกล้ถึงวันนัดอยู่บนสุด
      default:
        return { createdAt: 'desc' };
    }
  }

  /** เที่ยงคืนของ "วันนี้" (UTC) — ใช้กรอง upcoming */
  private startOfTodayUtc(): Date {
    const d = new Date();
    d.setUTCHours(0, 0, 0, 0);
    return d;
  }

  /** แปลง 1 row → CaregiverBookingSummary (ดูแลเรื่อง null / Decimal / privacy ที่นี่) */
  private toSummary(b: CaregiverBookingRow): CaregiverBookingSummary {
    // PDPA: เปิดเผยที่อยู่ละเอียดเฉพาะเมื่องานถูกยืนยันแล้ว (confirmed/completed)
    const addressVisible = b.status === 'confirmed' || b.status === 'completed';

    return {
      id: b.id,
      status: b.status,
      serviceType: b.serviceType,
      serviceLocations: b.serviceLocations ?? [],
      timeSlot: b.timeSlot,
      bookingDate: this.formatDateYmd(b.bookingDate),
      startTime: this.formatTimeHm(b.startTime),
      durationHours: this.toNumber(b.durationHours),
      estimatedCost: b.estimatedCost != null ? this.toNumber(b.estimatedCost) : undefined,
      locationAddress: addressVisible ? b.locationAddress : undefined,
      patient: {
        id: b.patient.id,
        displayName: b.patient.displayName ?? undefined,
        avatarUrl: b.patient.avatarUrl ?? undefined,
      },
      careRecipientName: b.careRecipient?.name ?? undefined,
      acceptedAt: b.acceptedAt ?? undefined,
      confirmedAt: b.confirmedAt ?? undefined,
      rejectionReason: b.rejectionReason ?? undefined,
      createdAt: b.createdAt,
    };
  }

  /** ประกอบ list + pagination ให้เป็น response เดียว */
  private toListResponse(
    items: CaregiverBookingRow[],
    { page, limit, total }: { page: number; limit: number; total: number },
  ): CaregiverBookingListResponse {
    const pagination: BookingPagination = {
      page,
      limit,
      total,
      totalPages: total === 0 ? 1 : Math.ceil(total / limit),
    };
    return { data: items.map((b) => this.toSummary(b)), pagination };
  }

  // ── ตัวช่วยแปลงค่า ────────────────────────────────────────────────────────

  /** Date → "YYYY-MM-DD" (เลี่ยงปัญหา timezone โดยตัดจาก ISO string) */
  private formatDateYmd(d: Date | string): string {
    return d instanceof Date ? d.toISOString().slice(0, 10) : String(d).slice(0, 10);
  }

  /**
   * Time → "HH:mm"
   * Prisma คืน @db.Time เป็น Date ที่ฝังเวลาไว้ใน UTC (1970-01-01Thh:mm:ssZ)
   * จึงตัดช่วง HH:mm จาก ISO string ได้ตรงค่าที่เก็บ
   */
  private formatTimeHm(t: Date | string): string {
    return t instanceof Date ? t.toISOString().slice(11, 16) : String(t).slice(0, 5);
  }

  /** รองรับทั้ง Prisma Decimal (มี .toNumber()) และ number ปกติ */
  private toNumber(v: { toNumber(): number } | number): number {
    return typeof v === 'number' ? v : v.toNumber();
  }
}
