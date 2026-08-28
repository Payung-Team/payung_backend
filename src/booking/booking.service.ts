import {
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { PrismaService } from '../common/prisma.service';
import { BOOKING_EVENTS, type BookingEvent } from '../notification/events/booking-event';
import { OmiseService } from '../payment/omise/omise.service';
import { PaymentStateMachine } from '../payment/payment-state-machine';
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
import { Prisma, booking_service_type, booking_status, time_slot } from '@prisma/client';
// PYG-424: จองแทนในนามกลุ่มครอบครัว
// import เฉพาะไฟล์ค่าคงที่กับ error ซึ่งเป็น plain object/class ไม่มี DI
// → ไม่ทำให้เกิด circular dependency ระหว่าง BookingModule กับ FamilyGroupModule
import {
  ACTIVITY_ACTION,
  ACTIVITY_TARGET,
} from '../family-group/family-group.constants';
import { RecipientNotInGroupError } from '../family-group/family-group.errors';

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
  // PYG-352: พิกัดจุดงาน — null ได้ (booking เก่าทุกใบเป็น null)
  locationLat: { toNumber(): number } | null;
  locationLng: { toNumber(): number } | null;
  bookingDate: Date;
  notes: string | null;
  estimatedCost: { toNumber(): number } | null;
  confirmedAt: Date | null;
  disputeStatus: string | null;
  disputeReason: string | null;
  createdAt: Date;
  // caregiver is nullable when booking is unmatched
  caregiver: {
    id: string;
    fullName: string | null;
    hourlyRate: number | null;
    user: { avatarUrl: string | null };
  } | null;
  careRecipient: { name: string } | null;
};

/**
 * PYG-424 — บริบท "จองแทนในนามกลุ่มครอบครัว"
 *
 * ส่งเข้า createBookingRecord เมื่อและเฉพาะเมื่อเป็นการจองแทนเท่านั้น
 * undefined = จองปกติ → โค้ดทุกบรรทัดที่เกี่ยวกับกลุ่มถูกข้ามทั้งหมด
 */
export interface OnBehalfContext {
  /** กลุ่มที่ใช้จอง — ต้องเป็นกลุ่มเดียวกับที่โปรไฟล์ผู้รับบริการถูกแชร์ไว้ */
  familyGroupId: string;
  /** users.id ของสมาชิกที่กดจองจริง ๆ */
  bookedBy: string;
  /** ชื่อผู้รับบริการ ณ เวลาที่จอง — เก็บลงฟีดกิจกรรมเพื่อให้อ่านย้อนหลังได้เสมอ */
  recipientName: string;
}

@Injectable()
export class BookingService {
  private readonly logger = new Logger(BookingService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly eventEmitter: EventEmitter2,
    // PYG-286: ใช้ใน cancelBooking auto-void เท่านั้น (held payment → reverse charge + FSM)
    private readonly omiseService: OmiseService,
    private readonly fsm: PaymentStateMachine,
  ) {}

  /**
   * ยิง booking event แบบ fire-and-forget (PYG-292)
   * - emit() ไม่ await → ไม่หน่วง response ของ mutation
   * - BookingNotificationListener (async + try/catch) จัดการ notification/email เอง
   *   error ฝั่ง listener จะไม่เด้งกลับมาที่นี่
   */
  private emit(event: BookingEvent): void {
    this.eventEmitter.emit(event.eventType, event);
  }

  // ── ① POST /api/v1/bookings ─────────────────────────────────────────────────

  /**
   * สร้าง Booking ใหม่ในสถานะ `unmatched` (ยังไม่มี caregiver)
   * caregiverId = null จนกว่า Phase 3 matching engine จะ assign
   */
  async createBooking(patientId: string, dto: CreateBookingDto): Promise<BookingRest> {
    const booking = await this.createBookingRecord(patientId, dto);
    return this.toRestSummary(booking);
  }

  // ── ①.5 PYG-424: จองแทนสมาชิกในกลุ่มครอบครัว (GraphQL) ─────────────────────

  /**
   * PYG-424 — สมาชิกกลุ่มครอบครัว "จองแทน" ผู้รับบริการที่ถูกแชร์ไว้ในกลุ่ม
   *
   * ── ใครเป็นเจ้าของ booking ใบนี้ ───────────────────────────────────────────
   *   patientId = คนกดจอง (ไม่ใช่เจ้าของโปรไฟล์ผู้รับบริการ)
   *   bookedBy  = คนกดจองเช่นกัน
   *
   *   ที่ต้องเป็นแบบนี้เพราะ "คนจ่ายเงินคือคนกดจอง" — ขั้นตอนจ่ายเงินเป็นคนละ step
   *   กับการสร้าง booking (ดู payment.service.ts) และตรงนั้นเช็คว่า booking.patientId
   *   ต้องเท่ากับคนที่กำลังจ่าย ถ้าตั้ง patientId เป็นเจ้าของโปรไฟล์แทน
   *   คนกดจองจะจ่ายเงิน booking ที่ตัวเองเพิ่งสร้างไม่ได้
   *
   *   ⚠ ข้อสมมติที่ต้องยืนยันกับ sequence diagram ของ PYG-410 (ตอนเขียนยังเข้าไม่ถึงไฟล์แนบ):
   *     ถ้าดีไซน์สรุปว่า "เจ้าของโปรไฟล์เป็นคนจ่าย" ให้แก้ค่า patientId ที่ส่งเข้า
   *     createBookingRecord บรรทัดเดียว แล้วต้องแก้เงื่อนไขฝั่ง payment ตามไปด้วย
   *
   * ── ทำไมยังไม่รับ memberDetails ────────────────────────────────────────────
   *   คอลัมน์ bookings.member_details (JSONB) มีอยู่แล้วจาก PYG-411 แต่ยังไม่รับค่า
   *   ในเวอร์ชันนี้ เพราะฟอร์ม FG-4 ยังไม่มีดีไซน์ (PYG-426 ยัง To Do) และ repo
   *   ยังไม่มี graphql-type-json ให้ประกาศ scalar JSON
   *   คอลัมน์เป็น nullable → เติมทีหลังได้โดยไม่ต้องแก้ migration หรือรื้อ mutation นี้
   */
  async createBookingOnBehalf(
    bookerId: string,
    input: CreateBookingDto & { groupId: string; careRecipientId: string },
  ): Promise<BookingSummary> {
    // สิทธิ์ "เป็นสมาชิก ACTIVE ของกลุ่มนี้" ถูกตรวจโดย FamilyGroupGuard มาแล้ว
    // ที่นี่จึงเหลือคำถามเดียวที่ guard ตอบให้ไม่ได้: โปรไฟล์คนไข้อยู่ในกลุ่มนี้จริงไหม
    const recipient = await this.prisma.careRecipient.findUnique({
      where: { id: input.careRecipientId },
      select: { id: true, name: true, familyGroupId: true },
    });

    // ไม่มีโปรไฟล์ หรือมีแต่เป็นของกลุ่มอื่น/เป็นโปรไฟล์ส่วนตัว → ตอบ error เดียวกัน (กันเดา id)
    if (!recipient || recipient.familyGroupId !== input.groupId) {
      throw new RecipientNotInGroupError();
    }

    const booking = await this.createBookingRecord(bookerId, input, {
      familyGroupId: input.groupId,
      bookedBy: bookerId,
      recipientName: recipient.name,
    });

    return this.toSummary(booking);
  }

  /**
   * แกนกลางการสร้าง booking — ใช้ร่วมกันระหว่างจองปกติ (REST) และจองแทน (GraphQL)
   *
   * แยกออกมาเพื่อไม่ให้ตรรกะร้อยกว่าบรรทัด (ตรวจ caregiver / เช็คเวลาชน / คำนวณราคา /
   * ยิง event) ถูกก๊อปไปไว้สองที่ แล้ววันหนึ่งแก้ที่เดียวลืมอีกที่
   */
  private async createBookingRecord(
    patientId: string,
    dto: CreateBookingDto,
    onBehalf?: OnBehalfContext,
  ): Promise<BookingWithIncludes> {
    // ตรวจสอบ careRecipientId ถ้าส่งมา — ต้องเป็นของ patient คนนี้
    //
    // PYG-424: ข้ามเช็คนี้เมื่อเป็นการจองแทน เพราะโปรไฟล์เป็นของ "สมาชิกคนอื่น"
    // ในกลุ่มโดยธรรมชาติ → เช็คแบบเดิมจะปฏิเสธการจองแทนทุกใบ
    // ความปลอดภัยไม่ได้หายไป แค่เปลี่ยนเกณฑ์: createBookingOnBehalf ตรวจว่า
    // "โปรไฟล์อยู่ในกลุ่มเดียวกับผู้เรียก" มาก่อนแล้ว ซึ่งเข้มพอกัน
    if (dto.careRecipientId && !onBehalf) {
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
    let estimatedCost: number | null = null;
    if (dto.caregiverId) {
      const caregiver = await this.prisma.caregiver.findUnique({
        where: { id: dto.caregiverId },
        select: { id: true, kycStatus: true, isSearchable: true, hourlyRate: true },
      });
      if (!caregiver || caregiver.kycStatus !== 'verified' || !caregiver.isSearchable) {
        throw new NotFoundException('Caregiver not found or unavailable');
      }
      resolvedCaregiverId = caregiver.id;
      if (caregiver.hourlyRate != null) {
        estimatedCost = caregiver.hourlyRate * dto.durationHours;
      }
    }

    // ── ตรวจสอบ time conflict ──────────────────────────────────────────────────
    const [startH, startM] = dto.startTime.split(':').map(Number);
    const newStart = startH * 60 + startM;
    const newEnd = newStart + Math.round(dto.durationHours * 60);
    const bookingDateObj = new Date(dto.bookingDate + 'T00:00:00.000Z');

    /**
     * PYG-424 — เช็คเวลาชน "ต่อผู้รับบริการ" ไม่ใช่ "ต่อคนจอง"
     *
     * ของเดิมกรองด้วย patientId อย่างเดียว ซึ่งให้คำตอบผิดสองทางพอมีการจองแทน:
     *   1) ลูกจองให้แม่ 9 โมง แล้วจองให้พ่อ 9 โมง → เคยถูกบล็อก
     *      ทั้งที่เป็นคนละคน ผู้ดูแลคนละคน จองพร้อมกันได้จริง
     *   2) สมาชิกสองคนจองให้ยายคนเดียวกัน เวลาเดียวกัน → เคยหลุดผ่าน
     *      ทั้งที่ยายอยู่สองที่พร้อมกันไม่ได้ (เคสนี้อันตรายกว่าเคสแรก)
     *
     * เกณฑ์ที่ถูกคือ "ร่างกายหนึ่งคนอยู่ได้ที่เดียว" → กรองด้วย careRecipientId
     * ไม่มี careRecipientId (จองให้ตัวเอง) = ผู้รับบริการคือ patient เอง
     * → กลับไปใช้ patientId เหมือนเดิมทุกประการ พฤติกรรมเดิมไม่เปลี่ยน
     */
    const conflictScope = dto.careRecipientId
      ? { careRecipientId: dto.careRecipientId }
      : { patientId };

    const conflicts = await this.prisma.booking.findMany({
      where: {
        ...conflictScope,
        bookingDate: bookingDateObj,
        status: { in: ['pending', 'confirmed'] },
      },
      select: { startTime: true, durationHours: true },
    });

    for (const b of conflicts) {
      const existStart = b.startTime.getUTCHours() * 60 + b.startTime.getUTCMinutes();
      const existDur = typeof (b.durationHours as any).toNumber === 'function'
        ? (b.durationHours as any).toNumber()
        : Number(b.durationHours);
      const existEnd = existStart + Math.round(existDur * 60);
      if (newStart < existEnd && existStart < newEnd) {
        // ข้อความแยกสองแบบ เพราะ "คุณมีนัดหมาย" จะงงมากเวลาที่กำลังจองแทนคนอื่นอยู่
        throw new ConflictException(
          dto.careRecipientId
            ? 'ผู้รับบริการคนนี้มีนัดหมายในช่วงเวลาเดียวกันอยู่แล้ว กรุณาเลือกเวลาอื่น'
            : 'คุณมีนัดหมายในช่วงเวลาเดียวกันอยู่แล้ว กรุณาเลือกเวลาอื่น',
        );
      }
    }

    const data: Prisma.BookingUncheckedCreateInput = {
      patientId,
      caregiverId:      resolvedCaregiverId,
      careRecipientId:  dto.careRecipientId ?? null,
      tasks:            dto.tasks,
      serviceLocations: dto.serviceLocations,
      serviceType:      dto.serviceType as booking_service_type,
      timeSlot:         dto.timeSlot as time_slot,
      startTime:        new Date(`1970-01-01T${dto.startTime}Z`),
      durationHours:    dto.durationHours,
      locationAddress:  dto.locationAddress,
      // PYG-352: เก็บพิกัดจุดงานที่ลูกค้าปักหมุดไว้ — ก่อนหน้านี้ค่านี้ถูกทิ้งทุกครั้ง
      // ระบบเช็คอินใช้พิกัดคู่นี้คำนวณระยะ ถ้าไม่มีก็ไม่คำนวณและไม่ติดธง
      locationLat:      dto.lat ?? null,
      locationLng:      dto.lng ?? null,
      bookingDate:      new Date(dto.bookingDate),
      notes:            dto.notes ?? null,
      patientName:              dto.patientName              ?? null,
      dayOfContactName:         dto.dayOfContactName         ?? null,
      dayOfContactPhone:        dto.dayOfContactPhone         ?? null,
      dayOfContactRelationship: dto.dayOfContactRelationship ?? null,
      estimatedCost:    estimatedCost,
      // มี caregiverId → pending ทันที; ไม่มี → unmatched (รอ matching engine)
      status: resolvedCaregiverId ? 'pending' : 'unmatched',
      // PYG-424: บริบทกลุ่ม — null ทั้งคู่เมื่อเป็นการจองปกติ (พฤติกรรมเดิม)
      familyGroupId: onBehalf?.familyGroupId ?? null,
      bookedBy:      onBehalf?.bookedBy      ?? null,
    };

    const include = {
      caregiver:     { include: { user: { select: { avatarUrl: true } } } },
      careRecipient: { select: { name: true } },
    };

    /**
     * จองแทน = ต้องเขียนฟีดกิจกรรมของกลุ่มใน transaction เดียวกับตัว booking
     * (กติกาข้อ 2 ของโมดูล family group — ดูหัวไฟล์ family-group.service.ts)
     *
     * ถ้าเขียนแยกกันแล้วอันใดอันหนึ่งพัง จะได้ฟีดที่โกหกว่ามีการจองที่ไม่เคยเกิดขึ้น
     * หรือมีการจองที่ไม่โผล่ในฟีดเลย ซึ่งทั้งสองแบบตรวจสอบย้อนหลังไม่ได้
     *
     * จองปกติไม่มีกลุ่มให้บันทึก → ใช้ create เดี่ยว ๆ เหมือนเดิม ไม่จ่ายค่า transaction ฟรี ๆ
     */
    const booking = onBehalf
      ? await this.prisma.$transaction(async (tx) => {
          const created = await tx.booking.create({ data, include });
          await tx.familyGroupActivity.create({
            data: {
              groupId:    onBehalf.familyGroupId,
              actorId:    onBehalf.bookedBy,
              action:     ACTIVITY_ACTION.BOOKING_ON_BEHALF,
              targetType: ACTIVITY_TARGET.BOOKING,
              targetId:   created.id,
              // เก็บชื่อผู้รับบริการลงฟีดไปเลย เพราะฟีดต้องอ่านออกแม้ภายหลัง
              // โปรไฟล์จะถูกลบหรือถูกย้ายออกจากกลุ่มไปแล้ว
              metadata: {
                recipientName: onBehalf.recipientName,
                bookingDate:   dto.bookingDate,
                startTime:     dto.startTime,
              },
            },
          });
          return created;
        })
      : await this.prisma.booking.create({ data, include });

    this.logger.log({
      event: 'booking.created',
      bookingId: booking.id,
      patientId,
      caregiverId: resolvedCaregiverId,
      status: booking.status,
      // PYG-424: ใส่บริบทกลุ่มลง log ด้วย เวลาไล่ปัญหาจะแยกออกทันทีว่าใบไหนมาจากการจองแทน
      familyGroupId: onBehalf?.familyGroupId ?? null,
    });

    // PYG-292: แจ้งเตือน caregiver ที่ถูก assign (ถ้า unmatched listener จะข้ามให้เอง)
    this.emit({
      bookingId: booking.id,
      eventType: BOOKING_EVENTS.CREATED,
      patientId,
      caregiverId: booking.caregiver?.userId ?? null,
    });

    return booking as unknown as BookingWithIncludes;
  }

  // ── ② PATCH /api/v1/bookings/:id/cancel ────────────────────────────────────

  /**
   * Patient ยกเลิก booking ของตัวเอง
   * อนุญาตเฉพาะ status: unmatched | pending | accepted
   * (ไม่อนุญาต: completed | cancelled | rejected)
   *
   * PYG-286: ถ้า booking มี payment 'held' (กันวงเงินไว้) → void hold ที่ Omise + FSM voided
   *   - Omise call นอก tx (HTTP, อย่าถือ tx ค้าง)
   *   - booking.update + FSM.transition(voided) ใน tx เดียว (atomic)
   *   - ยิง BOOKING_EVENTS.PAYMENT_VOIDED แยกจาก CANCELLED → patient รู้ว่า hold ถูกปล่อยแล้ว
   */
  async cancelBooking(bookingId: string, patientId: string): Promise<BookingRest> {
    const booking = await this.prisma.booking.findUnique({
      where: { id: bookingId },
      include: {
        caregiver:     { include: { user: { select: { avatarUrl: true } } } },
        careRecipient: { select: { name: true } },
        payment:       true,
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

    // PYG-286: เช็คว่ามี held payment ต้อง void หรือไม่
    // ใช้ != null เพื่อครอบทั้ง null และ undefined (test mocks อาจไม่ได้ใส่ field นี้)
    const payment = booking.payment;
    const shouldVoid =
      payment != null &&
      (payment.paymentStatus as PaymentStatus) === PaymentStatus.held &&
      !!payment.omiseChargeId;

    // void Omise นอก tx (ถ้ามี held payment) — fail → throw ServiceUnavailable, ไม่ cancel booking
    if (shouldVoid) {
      try {
        await this.omiseService.voidCharge(payment!.omiseChargeId!);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        this.logger.error(
          `[cancelBooking] Omise void failed for chargeId=${payment!.omiseChargeId}: ${msg}`,
        );
        throw new ServiceUnavailableException(
          'ไม่สามารถยกเลิกการกันวงเงินได้ในขณะนี้ กรุณาลองใหม่ภายหลัง',
        );
      }
    }

    // atomic: booking.cancelled + (ถ้า void แล้ว) FSM transition payment → voided
    const updated = await this.prisma.$transaction(async (tx) => {
      const u = await tx.booking.update({
        where: { id: bookingId },
        data:  { status: 'cancelled' },
        include: {
          caregiver:     { include: { user: { select: { avatarUrl: true } } } },
          careRecipient: { select: { name: true } },
        },
      });

      if (shouldVoid) {
        // FSM ตรวจกฎ held → voided + เขียน history (atomic ใน tx เดียว)
        await this.fsm.transition(
          payment!.id,
          PaymentStatus.voided,
          {
            changedBy: patientId,
            reason: 'booking cancelled by patient',
            metadata: {
              omiseChargeId: payment!.omiseChargeId,
              voidedAt: new Date().toISOString(),
            },
          },
          tx,
        );
      }

      return u;
    });

    this.logger.log({ event: 'booking.cancelled', bookingId, patientId, voided: shouldVoid });

    // PYG-292: แจ้ง caregiver ว่าผู้ใช้บริการยกเลิกการจอง
    this.emit({
      bookingId,
      eventType: BOOKING_EVENTS.CANCELLED,
      patientId,
      caregiverId: updated.caregiver?.userId ?? null,
    });

    // PYG-286: ถ้า void → แจ้ง patient ว่า hold ถูกปล่อย (ผู้รับ = patient เอง, in-app เป็น signal สำหรับ FE refresh wallet)
    if (shouldVoid) {
      this.eventEmitter.emit(BOOKING_EVENTS.PAYMENT_VOIDED, {
        bookingId,
        eventType: BOOKING_EVENTS.PAYMENT_VOIDED,
        patientId,
        caregiverId: updated.caregiver?.userId ?? null,
        metadata: {
          amount: payment!.amount,
          omiseChargeId: payment!.omiseChargeId,
        },
      });
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

    const where = { patientId: userId, status: 'accepted' as booking_status };
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
        orderBy: { createdAt: 'desc' },
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
      careRecipientName: booking.careRecipient?.name ?? undefined,
      confirmedAt:      booking.confirmedAt   ?? undefined,
      createdAt:        booking.createdAt,
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
      careRecipientName: booking.careRecipient?.name ?? undefined,
      confirmedAt:      booking.confirmedAt   ?? undefined,
      disputeStatus:    booking.disputeStatus ?? 'none',
      disputeReason:    booking.disputeReason ?? undefined,
      // PYG-352: พิกัดจุดงาน — FE ใช้ปักหมุด "จุดงาน" และวาดวงรัศมีสองวงบนแผนที่
      locationLat:      booking.locationLat != null ? booking.locationLat.toNumber() : undefined,
      locationLng:      booking.locationLng != null ? booking.locationLng.toNumber() : undefined,
      createdAt:        booking.createdAt,
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
