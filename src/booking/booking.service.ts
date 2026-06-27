import {
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { PrismaService } from '../common/prisma.service';
import { NotificationService } from '../notification/notification.service';
import { NotificationType } from '../notification/entities/notification-type.enum';
import { OmiseService } from '../payment/omise.service';
import { PaymentStatus } from '../payment/entities/payment-status.enum';
import {
  BookingListResponse,
  BookingPagination,
  BookingSummary,
  CaregiverBriefDto,
} from './dto/booking-summary.types';
import { BookingHistoryInput } from './dto/booking-history.input';
import { CreateBookingDto } from './dto/create-booking.dto';
import { SearchMatchesDto } from './dto/search-matches.dto';
import {
  BookingRest,
  CaregiverBriefRest,
  MatchedCaregiverRest,
  TaskSuggestion,
} from './dto/booking-rest.types';
// booking_service_type, booking_status, time_slot enums removed — bookings table columns are now TEXT after migration 20260620000001

// ── Static task suggestion map ────────────────────────────────────────────────
// Q3: static map per service_type (locale: Thai task labels)
const TASK_SUGGESTIONS: Record<string, string[]> = {
  elderly_care: [
    'อาบน้ำ',
    'ป้อนอาหาร',
    'พลิกตัว',
    'ทำความสะอาดห้อง',
    'จัดยา',
    'นวด',
    'เปลี่ยนผ้าอ้อม',
    'วัดความดัน',
    'พาเดินออกกำลังกาย',
  ],
  child_care: [
    'เล่นกับเด็ก',
    'ป้อนนม',
    'อาบน้ำ',
    'พาเดิน',
    'อ่านนิทาน',
    'ดูแลขณะนอนหลับ',
  ],
  medical_care: [
    'ดูแลแผล',
    'จัดยา',
    'วัดความดัน',
    'เจาะเลือด',
    'ดูแลสายสวน',
    'กายภาพบำบัด',
  ],
  housekeeping: [
    'ทำความสะอาด',
    'ซักผ้า',
    'ล้างจาน',
    'ปรุงอาหาร',
    'จัดของ',
    'รดน้ำต้นไม้',
  ],
  companion: [
    'พูดคุย',
    'พาเดิน',
    'อ่านหนังสือ',
    'ดูทีวีด้วยกัน',
    'ทำกิจกรรม',
  ],
};

// ── Internal booking shape including nullable caregiver ───────────────────────
type BookingWithIncludes = {
  id: string;
  patientId: string;
  status: string;
  serviceType: string;
  timeSlot: string;
  startTime: Date | null;
  durationHours: number | null;
  tasks: string[];
  serviceLocations: string[];
  locationAddress: string;
  bookingDate: Date;
  notes: string | null;
  estimatedCost: { toNumber(): number } | null;
  confirmedAt: Date | null;
  createdAt: Date;
  dayOfContactName: string | null;
  dayOfContactPhone: string | null;
  dayOfContactRelationship: string | null;
  patientName: string | null;
  // caregiver is nullable when booking is unmatched
  caregiver: {
    id: string;
    userId: string;
    fullName: string | null;
    hourlyRate: number | null;
    user: { avatarUrl: string | null };
  } | null;
  careRecipient: { name: string } | null;
};

@Injectable()
export class BookingService {
  private readonly logger = new Logger(BookingService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly notificationService: NotificationService,
    private readonly omise: OmiseService,
  ) {}

  // ── ① POST /api/v1/bookings ─────────────────────────────────────────────────

  /**
   * สร้าง Booking ใหม่ในสถานะ `unmatched` (ยังไม่มี caregiver)
   * caregiverId = null จนกว่า Phase 3 matching engine จะ assign
   */
  async createBooking(patientId: string, dto: CreateBookingDto): Promise<BookingRest> {
    // ตรวจสอบ careRecipientId ถ้าส่งมา — ต้องเป็นของ patient คนนี้
    if (dto.careRecipientId) {
      const recipient = await this.prisma.careRecipient.findUnique({
        where: { id: dto.careRecipientId },
        select: { patientId: true },
      });
      if (!recipient) throw new NotFoundException('Care recipient not found');
      if (recipient.patientId !== patientId)
        throw new ForbiddenException('Care recipient does not belong to this patient');
    }

    // ตรวจสอบ caregiverId ถ้าส่งมา — ต้องเป็น verified + searchable caregiver
    let resolvedCaregiverId: string | null = null;
    let caregiverUserId: string | null = null;
    let estimatedCost: number | null = null;
    if (dto.caregiverId) {
      const caregiver = await this.prisma.caregiver.findUnique({
        where: { id: dto.caregiverId },
        select: { id: true, userId: true, kycStatus: true, isSearchable: true, hourlyRate: true },
      });
      if (!caregiver || caregiver.kycStatus !== 'verified' || !caregiver.isSearchable) {
        throw new NotFoundException('Caregiver not found or unavailable');
      }
      resolvedCaregiverId = caregiver.id;
      caregiverUserId = caregiver.userId;
      if (caregiver.hourlyRate != null) {
        estimatedCost = caregiver.hourlyRate * dto.durationHours;
      }
    }

    // ตรวจสอบ time conflict กับนัดหมายที่ patient ยืนยันไปแล้ว
    const [startH, startM] = dto.startTime.split(':').map(Number);
    const newStart = startH * 60 + startM;
    const newEnd = newStart + Math.round(dto.durationHours * 60);
    const bookingDateObj = new Date(dto.bookingDate + 'T00:00:00.000Z');

    const patientConflicts = await this.prisma.booking.findMany({
      where: {
        patientId,
        bookingDate: bookingDateObj,
        status: { in: ['pending', 'confirmed'] },
      },
      select: { startTime: true, durationHours: true },
    });

    for (const b of patientConflicts) {
      const existStart = b.startTime.getUTCHours() * 60 + b.startTime.getUTCMinutes();
      const existDur = typeof (b.durationHours as any).toNumber === 'function'
        ? (b.durationHours as any).toNumber()
        : Number(b.durationHours);
      const existEnd = existStart + Math.round(existDur * 60);
      if (newStart < existEnd && existStart < newEnd) {
        throw new ConflictException('คุณมีนัดหมายในช่วงเวลาเดียวกันอยู่แล้ว กรุณาเลือกเวลาอื่น');
      }
    }

    const booking = await this.prisma.booking.create({
      data: {
        patientId,
        caregiverId:      resolvedCaregiverId,
        careRecipientId:  dto.careRecipientId ?? null,
        tasks:            dto.tasks,
        serviceLocations: dto.serviceLocations,
        serviceType:      dto.serviceType,
        timeSlot:         dto.timeSlot,
        startTime:        new Date(`1970-01-01T${dto.startTime}Z`),
        durationHours:    dto.durationHours,
        locationAddress:  dto.locationAddress,
        bookingDate:      new Date(dto.bookingDate),
        notes:            dto.notes ?? null,
        dayOfContactName:         dto.dayOfContactName         ?? null,
        dayOfContactPhone:        dto.dayOfContactPhone        ?? null,
        dayOfContactRelationship: dto.dayOfContactRelationship ?? null,
        patientName:              dto.patientName              ?? null,
        estimatedCost:    estimatedCost,
        // มี caregiverId → pending ทันที; ไม่มี → unmatched (รอ matching engine)
        status: resolvedCaregiverId ? 'pending' : 'unmatched',
      },
      include: {
        caregiver:     { include: { user: { select: { avatarUrl: true } } } },
        careRecipient: { select: { name: true } },
      },
    });

    this.logger.log({
      event: 'booking.created',
      bookingId: booking.id,
      patientId,
      caregiverId: resolvedCaregiverId,
      status: booking.status,
    });
    if (caregiverUserId) {
      void this.notificationService.create(
        caregiverUserId,
        NotificationType.booking_new,
        'มีคำขอจองใหม่',
        'ผู้ใช้บริการส่งคำขอจองบริการของคุณแล้ว กรุณาตรวจสอบและตอบรับ',
        { bookingId: booking.id },
      );
    }
    return this.toRestSummary(booking as unknown as BookingWithIncludes);
  }

  // ── ② PATCH /api/v1/bookings/:id/cancel ────────────────────────────────────

  /**
   * Patient ยกเลิก booking ของตัวเอง
   * อนุญาตเฉพาะ status: unmatched | pending | accepted
   * (ไม่อนุญาต: completed | cancelled | rejected)
   */
  async cancelBooking(bookingId: string, patientId: string): Promise<BookingRest> {
    const booking = await this.prisma.booking.findUnique({
      where: { id: bookingId },
      include: {
        caregiver:     { include: { user: { select: { avatarUrl: true } } } },
        careRecipient: { select: { name: true } },
      },
    });

    if (!booking) throw new NotFoundException('Booking not found');
    if (booking.patientId !== patientId)
      throw new ForbiddenException('Access denied');

    const cancellableStatuses = ['unmatched', 'pending', 'accepted'];
    if (!cancellableStatuses.includes(booking.status)) {
      throw new UnprocessableEntityException(
        `Cannot cancel a booking with status "${booking.status}". ` +
          `Only ${cancellableStatuses.join(', ')} bookings can be cancelled.`,
      );
    }

    // Check for a held payment that needs to be voided
    const payment = await this.prisma.payment.findFirst({
      where: { bookingId },
    });

    const shouldVoid =
      payment !== null &&
      (payment.paymentStatus as PaymentStatus) === PaymentStatus.held &&
      payment.omiseChargeId !== null;

    // Void at Omise outside DB transaction (same pattern as createPayment)
    if (shouldVoid) {
      try {
        await this.omise.voidCharge(payment.omiseChargeId!);
      } catch (err) {
        this.logger.error(
          `[cancelBooking] Omise void failed for chargeId=${payment.omiseChargeId}: ${(err as Error).message}`,
        );
        throw new ServiceUnavailableException(
          'ไม่สามารถยกเลิกการกันวงเงินได้ในขณะนี้ กรุณาลองใหม่ภายหลัง',
        );
      }
    }

    // Atomic: cancel booking + (if voided) update payment status + insert history
    const updated = await this.prisma.$transaction(async (tx) => {
      const updatedBooking = await tx.booking.update({
        where: { id: bookingId },
        data:  { status: 'cancelled' },
        include: {
          caregiver:     { include: { user: { select: { avatarUrl: true } } } },
          careRecipient: { select: { name: true } },
        },
      });

      if (shouldVoid) {
        await tx.payment.update({
          where: { id: payment.id },
          data:  { paymentStatus: PaymentStatus.voided, updatedAt: new Date() },
        });

        await tx.paymentStatusHistory.create({
          data: {
            paymentId:  payment.id,
            fromStatus: PaymentStatus.held,
            toStatus:   PaymentStatus.voided,
            changedBy:  patientId,
            reason:     'booking cancelled by patient',
            metadata:   { omiseChargeId: payment.omiseChargeId, voidedAt: new Date().toISOString() },
          },
        });
      }

      return updatedBooking;
    });

    if (shouldVoid) {
      this.logger.log(JSON.stringify({
        event:   'payment.voided',
        payload: { paymentId: payment.id, bookingId, chargeId: payment.omiseChargeId },
      }));
    }

    this.logger.log({ event: 'booking.cancelled', bookingId, patientId });
    if (updated.caregiver?.userId) {
      void this.notificationService.create(
        updated.caregiver.userId,
        NotificationType.booking_cancelled,
        'ผู้ใช้บริการยกเลิกการจอง',
        'การจองถูกยกเลิกโดยผู้ใช้บริการ',
        { bookingId },
      );
    }
    return this.toRestSummary(updated as unknown as BookingWithIncludes);
  }

  // ── ③ POST /api/v1/bookings/search-matches ─────────────────────────────────

  /**
   * ⚠️  BASIC PLACEHOLDER — Phase 3 matching engine จะแทนที่ logic นี้
   *
   * Filter พื้นฐาน:
   *  - isSearchable = true
   *  - kycStatus    = 'verified'
   *  - serviceAreaProvince ตรงกับ dto.province (ถ้าส่งมา)
   * เรียงตาม hourlyRate ASC (ถูกที่สุดก่อน)
   */
  async searchMatchesBasic(dto: SearchMatchesDto): Promise<MatchedCaregiverRest[]> {
    const where: Record<string, unknown> = {
      isSearchable: true,
      kycStatus:    'verified',
    };

    if (dto.province) {
      where.serviceAreaProvince = dto.province;
    }

    const caregivers = await this.prisma.caregiver.findMany({
      where,
      select: {
        id:                   true,
        fullName:             true,
        hourlyRate:           true,
        experienceYears:      true,
        skills:               true,
        serviceAreaProvince:  true,
        serviceAreaDistrict:  true,
        patientReviews:       { select: { rating: true } },
        user:                 { select: { avatarUrl: true } },
      },
      orderBy: { hourlyRate: 'asc' },
      take:    20, // hard cap — Phase 3 will paginate properly
    });

    return caregivers.map((cg) => {
      const reviewCount = cg.patientReviews.length;
      const avgRating =
        reviewCount > 0
          ? Math.round(
              (cg.patientReviews.reduce((s, r) => s + r.rating, 0) / reviewCount) * 100,
            ) / 100
          : undefined;

      return {
        id:              cg.id,
        fullName:        cg.fullName        ?? undefined,
        avatarUrl:       cg.user.avatarUrl  ?? undefined,
        hourlyRate:      cg.hourlyRate      ?? undefined,
        experienceYears: cg.experienceYears ?? undefined,
        skills:          cg.skills,
        province:        cg.serviceAreaProvince ?? undefined,
        district:        cg.serviceAreaDistrict ?? undefined,
        avgRating,
        reviewCount,
      };
    });
  }

  // ── ④ PATCH /api/v1/bookings/:id/recover ───────────────────────────────────

  /**
   * Phase 5B Recovery — reset booking ที่ถูก rejected กลับเป็น unmatched
   * - status: rejected → unmatched
   * - caregiverId → null (เพื่อให้ patient เลือก caregiver ใหม่จาก matched list)
   * - คืน BookingRest + matched list ให้ผู้ป่วยเลือกใหม่
   */
  async recoverBooking(
    bookingId: string,
    patientId: string,
  ): Promise<{ booking: BookingRest; matches: MatchedCaregiverRest[] }> {
    const booking = await this.prisma.booking.findUnique({
      where: { id: bookingId },
      select: {
        patientId:        true,
        status:           true,
        serviceType:      true,
        serviceLocations: true,
        timeSlot:         true,
        bookingDate:      true,
      },
    });

    if (!booking) throw new NotFoundException('Booking not found');
    if (booking.patientId !== patientId)
      throw new ForbiddenException('Access denied');
    if (booking.status !== 'rejected') {
      throw new UnprocessableEntityException(
        `Only rejected bookings can be recovered. Current status: "${booking.status}"`,
      );
    }

    const updated = await this.prisma.booking.update({
      where: { id: bookingId },
      data:  { status: 'unmatched', caregiverId: null },
      include: {
        caregiver:     { include: { user: { select: { avatarUrl: true } } } },
        careRecipient: { select: { name: true } },
      },
    });

    this.logger.log({ event: 'booking.recovered', bookingId, patientId });

    // Return fresh matched list so the patient can pick immediately
    const matches = await this.searchMatchesBasic({
      serviceType:      booking.serviceType,
      serviceLocations: booking.serviceLocations,
      bookingDate:      booking.bookingDate instanceof Date
                          ? booking.bookingDate.toISOString().slice(0, 10)
                          : String(booking.bookingDate),
    });

    return {
      booking: this.toRestSummary(updated as unknown as BookingWithIncludes),
      matches,
    };
  }

  // ── ⑤ GET /api/v1/booking-task-suggestions ─────────────────────────────────

  /**
   * คืนรายการ task แนะนำสำหรับ service_type ที่ระบุ
   * Q3: Static map — ไม่มี DB query
   */
  getTaskSuggestions(serviceType: string): TaskSuggestion[] {
    const labels = TASK_SUGGESTIONS[serviceType] ?? [];
    return labels.map((label) => ({ label }));
  }

  // ── Existing GraphQL service methods ───────────────────────────────────────

  async confirmBooking(bookingId: string, userId: string): Promise<BookingSummary> {
    const booking = await this.prisma.booking.findUnique({
      where: { id: bookingId },
      include: {
        caregiver: { include: { user: { select: { avatarUrl: true } } } },
        careRecipient: { select: { name: true } },
      },
    });

    if (!booking) throw new NotFoundException('Booking not found');
    if (booking.patientId !== userId) throw new ForbiddenException('Access denied');
    if (booking.status !== 'accepted') {
      throw new UnprocessableEntityException(
        'Only bookings with status "accepted" can be confirmed',
      );
    }

    const updated = await this.prisma.booking.update({
      where: { id: bookingId },
      data: { status: 'confirmed', confirmedAt: new Date() },
      include: {
        caregiver: { include: { user: { select: { avatarUrl: true } } } },
        careRecipient: { select: { name: true } },
      },
    });

    this.logger.log({ event: 'booking.confirmed', bookingId, userId });
    if (updated.caregiver?.userId) {
      void this.notificationService.create(
        updated.caregiver.userId,
        NotificationType.booking_confirmed,
        'ผู้ใช้บริการยืนยันการจอง',
        'ผู้ใช้บริการยืนยันและชำระเงินสำหรับการจองแล้ว',
        { bookingId },
      );
    }
    return this.toSummary(updated as unknown as BookingWithIncludes);
  }

  async myBookingById(bookingId: string, userId: string): Promise<BookingSummary> {
    const booking = await this.prisma.booking.findUnique({
      where: { id: bookingId },
      include: {
        caregiver:     { include: { user: { select: { avatarUrl: true } } } },
        careRecipient: { select: { name: true } },
      },
    });
    if (!booking) throw new NotFoundException('Booking not found');
    if (booking.patientId !== userId) throw new ForbiddenException('Access denied');
    return this.toSummary(booking as unknown as BookingWithIncludes);
  }

  async myPendingConfirmations(
    userId: string,
    page = 1,
    limit = 10,
  ): Promise<BookingListResponse> {
    page  = Math.max(1, page);
    limit = Math.min(50, Math.max(1, limit));
    const offset = (page - 1) * limit;

    const where = { patientId: userId, status: 'accepted' };
    const [items, total] = await Promise.all([
      this.prisma.booking.findMany({
        where,
        include: {
          caregiver: { include: { user: { select: { avatarUrl: true } } } },
          careRecipient: { select: { name: true } },
        },
        orderBy: { bookingDate: 'asc' },
        skip: offset,
        take: limit,
      }),
      this.prisma.booking.count({ where }),
    ]);

    return this.toListResponse(items as unknown as BookingWithIncludes[], { page, limit, total });
  }

  async myBookingHistory(
    userId: string,
    input: BookingHistoryInput,
  ): Promise<BookingListResponse> {
    const page  = Math.max(1, input.page  ?? 1);
    const limit = Math.min(50, Math.max(1, input.limit ?? 10));
    const offset = (page - 1) * limit;

    const where: Record<string, unknown> = { patientId: userId };
    if (input.status) where.status = input.status;

    const [items, total] = await Promise.all([
      this.prisma.booking.findMany({
        where,
        include: {
          caregiver: { include: { user: { select: { avatarUrl: true } } } },
          careRecipient: { select: { name: true } },
        },
        orderBy: { bookingDate: 'asc' },
        skip: offset,
        take: limit,
      }),
      this.prisma.booking.count({ where }),
    ]);

    return this.toListResponse(items as unknown as BookingWithIncludes[], { page, limit, total });
  }

  // ── Private helpers ─────────────────────────────────────────────────────────

  /** REST summary (caregiver may be null for unmatched bookings) */
  private toRestSummary(booking: BookingWithIncludes): BookingRest {
    const caregiver: CaregiverBriefRest | undefined = booking.caregiver
      ? {
          id:         booking.caregiver.id,
          fullName:   booking.caregiver.fullName   ?? undefined,
          avatarUrl:  booking.caregiver.user.avatarUrl ?? undefined,
          hourlyRate: booking.caregiver.hourlyRate ?? undefined,
        }
      : undefined;

    return {
      id:               booking.id,
      bookingDate:      booking.bookingDate instanceof Date
                          ? booking.bookingDate.toISOString().slice(0, 10)
                          : String(booking.bookingDate),
      status:           booking.status,
      serviceType:      booking.serviceType,
      timeSlot:         booking.timeSlot,
      tasks:            booking.tasks,
      serviceLocations: booking.serviceLocations,
      locationAddress:  booking.locationAddress,
      notes:            booking.notes ?? undefined,
      estimatedCost:    booking.estimatedCost != null
                          ? booking.estimatedCost.toNumber()
                          : undefined,
      caregiver,
      careRecipientName:        booking.careRecipient?.name           ?? undefined,
      patientName:              booking.patientName                   ?? undefined,
      dayOfContactName:         booking.dayOfContactName              ?? undefined,
      dayOfContactPhone:        booking.dayOfContactPhone             ?? undefined,
      dayOfContactRelationship: booking.dayOfContactRelationship      ?? undefined,
      confirmedAt:              booking.confirmedAt                   ?? undefined,
      createdAt:                booking.createdAt,
    };
  }

  /** GraphQL summary — caregiver may be null for unmatched bookings */
  private toSummary(booking: BookingWithIncludes): BookingSummary {
    const caregiver: CaregiverBriefDto | undefined = booking.caregiver
      ? {
          id:         booking.caregiver.id,
          fullName:   booking.caregiver.fullName   ?? undefined,
          avatarUrl:  booking.caregiver.user.avatarUrl ?? undefined,
          hourlyRate: booking.caregiver.hourlyRate ?? undefined,
        }
      : undefined;

    return {
      id:               booking.id,
      bookingDate:      booking.bookingDate instanceof Date
                          ? booking.bookingDate.toISOString().slice(0, 10)
                          : String(booking.bookingDate),
      status:           booking.status,
      serviceType:      booking.serviceType,
      timeSlot:         booking.timeSlot,
      startTime:        booking.startTime instanceof Date
                          ? booking.startTime.toISOString().slice(11, 16)
                          : undefined,
      durationHours:    booking.durationHours ?? undefined,
      tasks:            booking.tasks,
      serviceLocations: booking.serviceLocations,
      locationAddress:  booking.locationAddress,
      notes:            booking.notes ?? undefined,
      estimatedCost:    booking.estimatedCost != null
                          ? booking.estimatedCost.toNumber()
                          : undefined,
      caregiver,
      careRecipientName:        booking.careRecipient?.name           ?? undefined,
      patientName:              booking.patientName                   ?? undefined,
      dayOfContactName:         booking.dayOfContactName              ?? undefined,
      dayOfContactPhone:        booking.dayOfContactPhone             ?? undefined,
      dayOfContactRelationship: booking.dayOfContactRelationship      ?? undefined,
      confirmedAt:              booking.confirmedAt                   ?? undefined,
      createdAt:                booking.createdAt,
    };
  }

  private toListResponse(
    items: BookingWithIncludes[],
    { page, limit, total }: { page: number; limit: number; total: number },
  ): BookingListResponse {
    const pagination: BookingPagination = {
      page,
      limit,
      total,
      totalPages: total === 0 ? 1 : Math.ceil(total / limit),
    };
    return { data: items.map((b) => this.toSummary(b)), pagination };
  }
}
