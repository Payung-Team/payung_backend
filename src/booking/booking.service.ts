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
import {
  RecipientNotInGroupError,
  MemberNotFoundError,
  PatientNameRequiredError,
} from '../family-group/family-group.errors';
import type { MemberDetailsInput } from '../family-group/dto/create-booking-on-behalf.input';
import { GroupBookingSummary } from '../family-group/entities/group-booking.entity';
// PYG-460: แปลงข้อความไทยจากฟอร์ม → คอลัมน์/enum ของ care_recipients (ตาราง mapping ที่เดียว)
import { toCareRecipientColumns } from '../patient/patient-profile.mapper';
// PYG-434: ใบ QR ของงาน — สร้างพร้อม booking ใน transaction เดียวกัน
import { JobQrService } from '../monitoring/qr/job-qr.service';

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
  /**
   * PYG-385: อาการ/รายละเอียดที่สมาชิกกรอกตอนจองแทน → คอลัมน์ bookings.member_details (JSONB).
   * undefined = ไม่ได้กรอก → คอลัมน์เป็น NULL (พฤติกรรมเดิม)
   */
  memberDetails?: MemberDetailsInput;
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
    // PYG-434: สร้างใบ QR เช็คอิน/เช็คเอาท์ พร้อมกับ booking ใน transaction เดียวกัน
    private readonly jobQrService: JobQrService,
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
   * ── memberDetails — สองเส้นทางเขียนคอลัมน์เดียวกัน (PYG-385 + PYG-460) ───────
   *   bookings.member_details (JSONB) มีมาตั้งแต่ PYG-411 ตอนนี้มีสองที่ที่เขียนลงไป:
   *
   *   ① จองแทนในกลุ่ม (GraphQL, PYG-385) — รับผ่าน MemberDetailsInput
   *      (structured input แทน JSON scalar — repo จงใจไม่พึ่ง graphql-type-json)
   *      4 ช่อง: conditions / medicines / allergies / careInstructions
   *   ② จองปกติ (REST, PYG-460) — รับผ่าน CreateBookingDto.patientProfile
   *      11 ช่อง ซึ่งคลุม 4 ช่องของ ① ทั้งหมด และชื่อฟิลด์ตรงกันเป๊ะ
   *
   *   ★ ที่ใช้คอลัมน์เดียวกันได้โดยไม่ตีกัน เพราะรูปทรงของ ① เป็น subset แท้ของ ②
   *     → CaregiverBookingSummary.patientProfile อ่านแถวที่มาจากเส้นทางไหนก็ได้
   *       ช่องที่ ① ไม่ได้กรอกจะเป็น null ซึ่ง type ประกาศเป็น nullable อยู่แล้ว
   *     ถ้าวันหนึ่งรูปทรงสองฝั่งแตกออกจากกัน ต้องแยกคอลัมน์ ไม่ใช่ยัดต่อในก้อนเดิม
   *
   *   ⚠ เพดานความยาวยังไม่ตรงกัน: ① medicines/allergies 1000 · ② 2000
   *     ข้อมูลชุดเดียวกันจึงผ่าน validation เส้นทางหนึ่งแต่ตกอีกเส้นทางได้
   *     ยังไม่แก้ในรอบนี้เพราะเป็นการเปลี่ยนสัญญาของ API ที่ merge ไปแล้ว — แยกตั๋ว
   *
   *   ไม่ได้กรอกทั้งสองเส้นทาง → คอลัมน์เป็น NULL เหมือนเดิม ไม่ต้องแก้ migration
   */
  async createBookingOnBehalf(
    bookerId: string,
    input: CreateBookingDto & {
      groupId: string;
      // PYG-500: โมเดล "สมาชิก = patient" — ส่งอย่างใดอย่างหนึ่ง
      memberUserId?: string;   // แนะนำ: เลือกสมาชิกในกลุ่มเป็นผู้รับบริการ
      careRecipientId?: string; // เส้นทางเดิม: อ้างโปรไฟล์ที่แชร์ในกลุ่มตรง ๆ
      patientName?: string;     // ใช้ตอนสมาชิกยังไม่มีข้อมูลแล้วคนจองกรอกให้
      memberDetails?: MemberDetailsInput;
    },
  ): Promise<BookingSummary> {
    // สิทธิ์ "ผู้เรียกเป็นสมาชิก ACTIVE ของกลุ่มนี้" ถูกตรวจโดย FamilyGroupGuard มาแล้ว
    // ที่นี่เหลือการ resolve ว่า booking ใบนี้ผูกกับโปรไฟล์ผู้รับบริการใบไหน (careRecipientId)
    let recipientId: string;
    let recipientName: string;

    if (input.memberUserId) {
      // PYG-500 — โมเดลใหม่: patient คือ "สมาชิกในกลุ่ม" ระบบหา/สร้างโปรไฟล์ให้อัตโนมัติ
      const resolved = await this.resolveGroupPatientProfile(
        input.groupId,
        input.memberUserId,
        input.patientName,
        input.memberDetails,
      );
      recipientId = resolved.id;
      recipientName = resolved.name;
    } else if (input.careRecipientId) {
      // เส้นทางเดิม (PYG-424): อ้างโปรไฟล์ที่แชร์ในกลุ่มตรง ๆ
      // ไม่มีโปรไฟล์ หรือมีแต่เป็นของกลุ่มอื่น/เป็นโปรไฟล์ส่วนตัว → ตอบ error เดียวกัน (กันเดา id)
      const recipient = await this.prisma.careRecipient.findUnique({
        where: { id: input.careRecipientId },
        select: { id: true, name: true, familyGroupId: true },
      });
      if (!recipient || recipient.familyGroupId !== input.groupId) {
        throw new RecipientNotInGroupError();
      }
      recipientId = recipient.id;
      recipientName = recipient.name;
    } else {
      // ไม่ได้ส่งทั้งคู่ — ต้องระบุว่าจองแทน "ใคร"
      throw new RecipientNotInGroupError();
    }

    const booking = await this.createBookingRecord(
      bookerId,
      { ...input, careRecipientId: recipientId },
      {
        familyGroupId: input.groupId,
        bookedBy: bookerId,
        recipientName,
        // PYG-385: undefined เมื่อไม่ได้กรอก — createBookingRecord จะไม่แตะคอลัมน์ให้ (คง NULL)
        memberDetails: input.memberDetails,
      },
    );

    return this.toSummary(booking);
  }

  /**
   * PYG-500 — หา/สร้าง "โปรไฟล์ผู้รับบริการในกลุ่ม" ของสมาชิกที่ถูกจองแทน (โมเดลสมาชิก = patient)
   *
   * ลำดับความสำคัญ (ตามที่เจ้าของสรุปไว้):
   *   ① มีโปรไฟล์ในกลุ่มของสมาชิกคนนี้อยู่แล้ว → ใช้ใบนั้น (ไม่แตะ self_reported เดิม)
   *   ② ยังไม่มี แต่สมาชิกมี "โปรไฟล์ส่วนตัว" อยู่ → คัดลอกข้อมูลนั้นเข้ากลุ่ม, self_reported = true
   *      (= ข้อมูลจากเจ้าตัว) เก็บเป็น snapshot ไม่ผูกกับโปรไฟล์ส่วนตัวเดิม เพื่อไม่ให้แก้ทีหลังย้อนกระทบ
   *   ③ ไม่มีข้อมูลเลย → คนจองกรอกให้ (ต้องมีชื่อ), self_reported = false (= คนอื่นกรอกให้)
   *
   * patientId ของโปรไฟล์ที่สร้าง = memberUserId (subject) เสมอ — เพื่อให้ลิสต์/ฟีดของกลุ่ม
   * อ้างกลับได้ว่า "โปรไฟล์นี้คือของสมาชิกคนไหน" (FE ก็ key ด้วย patientId อยู่แล้ว)
   *
   * ★ อยู่นอก transaction ของ booking โดยตั้งใจ: โปรไฟล์กลุ่มที่ค้างโดยไม่มี booking
   *   ไม่เป็นอันตราย (แค่ทำให้สมาชิกคนนั้น "จองแทนได้" ซึ่งเป็นผลที่ต้องการอยู่แล้ว)
   */
  private async resolveGroupPatientProfile(
    groupId: string,
    memberUserId: string,
    patientName?: string,
    memberDetails?: MemberDetailsInput,
  ): Promise<{ id: string; name: string }> {
    // subject ต้องเป็นสมาชิก ACTIVE ของกลุ่มนี้ (guard ตรวจแค่ "ผู้เรียก" ไม่ได้ตรวจ "คนที่ถูกจองให้")
    const membership = await this.prisma.familyGroupMember.findFirst({
      where: { groupId, userId: memberUserId, status: 'ACTIVE' },
      select: { userId: true },
    });
    if (!membership) throw new MemberNotFoundError();

    // ① โปรไฟล์ในกลุ่มที่มีอยู่แล้ว
    const existing = await this.prisma.careRecipient.findFirst({
      where: { patientId: memberUserId, familyGroupId: groupId, is_deleted: false },
      select: { id: true, name: true },
      orderBy: { updated_at: 'desc' },
    });
    if (existing) return existing;

    // ② คัดลอกจากโปรไฟล์ส่วนตัวของสมาชิก (familyGroupId = null) — เอาใบที่เป็น is_self ก่อน แล้วใบล่าสุด
    const personal = await this.prisma.careRecipient.findFirst({
      where: { patientId: memberUserId, familyGroupId: null, is_deleted: false },
      orderBy: [{ is_self: 'desc' }, { updated_at: 'desc' }],
    });
    if (personal) {
      const copy = await this.prisma.careRecipient.create({
        data: {
          patientId:               memberUserId,
          familyGroupId:           groupId,
          self_reported:           true,
          name:                    personal.name,
          nickname:                personal.nickname,
          date_of_birth:           personal.date_of_birth,
          gender:                  personal.gender,
          weight_kg:               personal.weight_kg,
          height_cm:               personal.height_cm,
          mobility_level:          personal.mobility_level,
          medical_conditions:      personal.medical_conditions,
          current_medications:     personal.current_medications,
          allergies:               personal.allergies,
          blood_type:              personal.blood_type,
          address_line:            personal.address_line,
          province:                personal.province,
          district:                personal.district,
          emergency_contact_name:  personal.emergency_contact_name,
          emergency_contact_phone: personal.emergency_contact_phone,
          emergency_contact_rel:   personal.emergency_contact_rel,
          preferred_hospital:      personal.preferred_hospital,
          care_notes:              personal.care_notes,
        },
        select: { id: true, name: true },
      });
      this.logger.log({
        event: 'group_care_recipient.provisioned',
        groupId,
        memberUserId,
        careRecipientId: copy.id,
        source: 'personal_profile',
      });
      return copy;
    }

    // ③ สมาชิกยังไม่มีข้อมูลเลย → คนจองกรอกให้ (self_reported = false)
    const name = patientName?.trim();
    if (!name) throw new PatientNameRequiredError();
    const created = await this.prisma.careRecipient.create({
      data: {
        patientId:           memberUserId,
        familyGroupId:       groupId,
        self_reported:       false,
        name,
        medical_conditions:  memberDetails?.conditions ?? [],
        current_medications: memberDetails?.medicines ?? null,
        allergies:           memberDetails?.allergies ?? null,
        care_notes:          memberDetails?.careInstructions ?? null,
      },
      select: { id: true, name: true },
    });
    this.logger.log({
      event: 'group_care_recipient.provisioned',
      groupId,
      memberUserId,
      careRecipientId: created.id,
      source: 'booker_filled',
    });
    return created;
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
      // PYG-460: ข้อมูลสุขภาพ ณ วันจอง — เก็บรูปทรงเดียวกับที่ FE ส่งมาเป๊ะ ๆ
      // (SavedRecipient.details) เพื่อให้ฝั่งอ่านไม่ต้องแปลงอีกชั้น
      // เป็น snapshot โดยตั้งใจ: แก้โปรไฟล์วันหลังต้องไม่ย้อนไปเปลี่ยนงานที่ทำไปแล้ว
      memberDetails:    (dto.patientProfile as Prisma.InputJsonValue | undefined) ?? undefined,
      estimatedCost:    estimatedCost,
      // มี caregiverId → pending ทันที; ไม่มี → unmatched (รอ matching engine)
      status: resolvedCaregiverId ? 'pending' : 'unmatched',
      // PYG-424: บริบทกลุ่ม — null ทั้งคู่เมื่อเป็นการจองปกติ (พฤติกรรมเดิม)
      familyGroupId: onBehalf?.familyGroupId ?? null,
      bookedBy:      onBehalf?.bookedBy      ?? null,
    };

    // PYG-385: เซ็ต member_details เฉพาะตอนจองแทนและมีการกรอกจริง — ไม่งั้นปล่อยคอลัมน์เป็น NULL
    // (แตะเฉพาะเมื่อมีค่า เพราะ Prisma แยก JSON null กับ DB null; การไม่กรอก = DB null)
    //
    // PYG-460: บรรทัดนี้เขียนทับค่าที่ data literal ข้างบนตั้งจาก dto.patientProfile
    // ในทางปฏิบัติสองเส้นทางไม่เคยชนกันจริง เพราะ CreateBookingOnBehalfInput (GraphQL)
    // ไม่มีฟิลด์ patientProfile และ REST ก็ไม่เคยมี onBehalf — ลำดับนี้จึงเป็นแค่การ
    // ประกาศให้ชัดว่า "ถ้าวันหนึ่งมีทั้งคู่ ให้ของการจองแทนชนะ" ซึ่งถูกต้องเพราะ
    // คนจองแทนคือคนที่เพิ่งกรอกข้อมูลอาการมากับ mutation นั้นโดยตรง
    if (onBehalf?.memberDetails !== undefined) {
      // MemberDetailsInput มีเฉพาะฟิลด์ string/string[]/undefined → เก็บเป็น JSON ได้ตรง ๆ
      data.memberDetails = onBehalf.memberDetails as unknown as Prisma.InputJsonValue;
    }

    const include = {
      caregiver:     { include: { user: { select: { avatarUrl: true } } } },
      careRecipient: { select: { name: true } },
    };

    /**
     * ทุกอย่างที่ "ต้องเกิดพร้อม booking" อยู่ใน transaction เดียวกันหมด
     *
     * ① ตัว booking เอง
     * ② PYG-424 — ฟีดกิจกรรมของกลุ่ม (เฉพาะตอนจองแทน)
     *    กติกาข้อ 2 ของโมดูล family group (ดูหัวไฟล์ family-group.service.ts)
     *    ถ้าเขียนแยกกันแล้วอันใดอันหนึ่งพัง จะได้ฟีดที่โกหกว่ามีการจองที่ไม่เคยเกิดขึ้น
     *    หรือมีการจองที่ไม่โผล่ในฟีดเลย ซึ่งทั้งสองแบบตรวจสอบย้อนหลังไม่ได้
     * ③ PYG-434 — ใบ QR สำหรับเช็คอิน/เช็คเอาท์ (ทุกใบ ไม่มีข้อยกเว้น)
     *
     * ⚠ ก่อนหน้านี้ "จองปกติ" ใช้ create เดี่ยว ๆ เพื่อไม่จ่ายค่า transaction ฟรี ๆ
     *   PYG-434 เปลี่ยนให้ใช้ transaction ทุกเส้นทาง เพราะ AC เขียนว่า
     *   "ทุก booking ใหม่มี JobSession PENDING + token" — คำว่า "ทุก" จะเป็นจริงได้
     *   ก็ต่อเมื่อ booking กับ QR เกิดหรือไม่เกิดพร้อมกันเท่านั้น
     *   ถ้าสร้างแยกกันแล้วขั้นที่สองพัง จะเหลือ booking ที่เช็คอินไม่ได้ตลอดไป
     *   และไม่มีอะไรในระบบคอยตามซ่อมให้ — ค่า transaction หนึ่งครั้งถูกกว่ามาก
     */
    const booking = await this.prisma.$transaction(async (tx) => {
      /**
       * ⓪ PYG-460 — ติ๊ก "บันทึกผู้รับบริการรายนี้ไว้" → สร้างโปรไฟล์ก่อน แล้วผูกกับ booking
       *
       * อยู่ใน transaction เดียวกันเพราะถ้าแยกกันแล้ว booking พังทีหลัง จะเหลือ
       * โปรไฟล์ค้างในลิสต์ที่ผู้ใช้ไม่ได้ตั้งใจสร้าง และกดจองใหม่จะได้ซ้ำอีกใบ
       *
       * ข้ามเมื่อ:
       *   - ส่ง careRecipientId มาแล้ว = เลือกโปรไฟล์เดิมอยู่ ไม่ต้องสร้างซ้ำ
       *   - จองแทน (onBehalf) = โปรไฟล์เป็นของสมาชิกในกลุ่ม มีอยู่ก่อนแล้วเสมอ
       *   - ไม่มีชื่อคนไข้ = ไม่มีอะไรจะตั้งเป็น name ซึ่งเป็นคอลัมน์ NOT NULL
       */
      if (dto.saveAsProfile && !dto.careRecipientId && !onBehalf && dto.patientName) {
        const savedProfile = await tx.careRecipient.create({
          data: {
            patientId,
            name: dto.patientName,
            ...(dto.patientProfile ? toCareRecipientColumns(dto.patientProfile) : {}),
          },
          select: { id: true },
        });
        data.careRecipientId = savedProfile.id;

        this.logger.log({
          event: 'care_recipient.created_from_booking',
          careRecipientId: savedProfile.id,
          patientId,
        });
      }

      const created = await tx.booking.create({ data, include });

      // ② จองแทนเท่านั้น — จองปกติไม่มีกลุ่มให้บันทึก
      if (onBehalf) {
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
      }

      // ③ ใบ QR — คำนวณช่วงเวลาที่สแกนได้จากตารางงานของ booking ที่เพิ่งสร้าง
      //    ส่ง tx เข้าไปเพื่อให้อยู่ใน transaction เดียวกัน (service บังคับรับ tx)
      await this.jobQrService.createForBooking(tx, created);

      return created;
    });

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

  // ── ①.6 PYG-385: ฟีดนัดหมายของกลุ่มครอบครัว (GraphQL) ──────────────────────

  /**
   * นัดหมาย "จองแทน" ทั้งหมดของกลุ่ม — ทุกสมาชิกเห็นร่วมกัน (family group §2: ฟีดต้องตรงกัน
   * ทุกคน). กรองด้วย familyGroupId เท่านั้น เพราะการจองปกติ (familyGroupId = null) ไม่เกี่ยว
   * กับกลุ่ม. เรียงล่าสุดก่อน; take 100 พอสำหรับกลุ่มครอบครัว (เพดานสมาชิก 10 คน) โดยไม่ต้อง
   * ทำ pagination ให้ FE ในเวอร์ชันนี้.
   *
   * สิทธิ์ "เป็นสมาชิก ACTIVE ของกลุ่ม" ถูกตรวจโดย FamilyGroupGuard ที่ resolver แล้ว.
   */
  async groupBookings(
    groupId: string,
    viewerUserId: string,
  ): Promise<GroupBookingSummary[]> {
    const items = await this.prisma.booking.findMany({
      where: { familyGroupId: groupId },
      include: {
        caregiver: { include: { user: { select: { avatarUrl: true } } } },
        careRecipient: { select: { name: true } },
        bookedByUser: { select: { displayName: true } },
        payment: { select: { paymentStatus: true } },
        // เวลาเช็คอินจริงสำหรับการ์ด "กำลังบริการ" — JOB_EVENT_TYPE.CHECK_IN ('check_in')
        jobEvents: {
          where: { eventType: 'check_in' },
          select: { deviceTs: true, serverTs: true },
          take: 1,
        },
      },
      orderBy: [{ bookingDate: 'desc' }, { startTime: 'desc' }],
      take: 100,
    });

    // เวลาเช็คอินเก็บเป็น timestamptz (UTC) → แสดงเป็นเวลาไทยเสมอ ไม่พึ่ง TZ ของเซิร์ฟเวอร์
    const bkkTime = new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Asia/Bangkok',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    });

    return items.map((b) => ({
      id: b.id,
      bookingDate:
        b.bookingDate instanceof Date
          ? b.bookingDate.toISOString().slice(0, 10)
          : String(b.bookingDate),
      startTime:
        b.startTime instanceof Date
          ? b.startTime.toISOString().slice(11, 16)
          : undefined,
      status: b.status,
      serviceType: b.serviceType,
      durationHours: b.durationHours != null ? Number(b.durationHours) : undefined,
      careRecipientName: b.careRecipient?.name ?? undefined,
      caregiver: b.caregiver
        ? {
            id: b.caregiver.id,
            fullName: b.caregiver.fullName ?? undefined,
            avatarUrl: b.caregiver.user.avatarUrl ?? undefined,
            hourlyRate:
              b.caregiver.hourlyRate != null ? Number(b.caregiver.hourlyRate) : undefined,
          }
        : undefined,
      bookedByName: b.bookedByUser?.displayName ?? undefined,
      bookedByUserId: b.bookedBy ?? undefined,
      bookedByMe: b.bookedBy === viewerUserId,
      estimatedCost: b.estimatedCost != null ? Number(b.estimatedCost) : undefined,
      serviceLocations: b.serviceLocations ?? [],
      locationAddress: b.locationAddress ?? undefined,
      paymentStatus: b.payment?.paymentStatus ?? undefined,
      checkInTime: (() => {
        const ev = b.jobEvents?.[0];
        const ts = ev?.deviceTs ?? ev?.serverTs;
        return ts ? bkkTime.format(ts) : undefined;
      })(),
    }));
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
