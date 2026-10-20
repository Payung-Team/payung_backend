import {
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { PrismaService } from '../common/prisma.service';
import { assertBookingAssessment } from '../assessment/assessment-booking-gate';
import { lockRequiredSkillRecipient, recalculateBookingRequiredSkills } from './required-skills/required-skills.persistence';
import { readSavedRequiredSkills } from './required-skills/required-skills.read';
import { AvatarUrlService } from '../common/avatar-url.service';
import { BOOKING_EVENTS, type BookingEvent } from '../notification/events/booking-event';
import { BookingSettlementService } from '../payment/settlement/booking-settlement.service';
import { SettlementReason } from '../payment/settlement/booking-settlement.types';
import {
  BookingListResponse,
  BookingPagination,
  BookingSummary,
  CaregiverBriefDto,
} from './dto/booking-summary.types';
import { BookingHistoryInput } from './dto/booking-history.input';
import { PatientProfileType } from './dto/patient-profile.type';
import { CreateBookingDto } from './dto/create-booking.dto';
import { SearchMatchesDto } from './dto/search-matches.dto';
import {
  BookingRest,
  CaregiverBriefRest,
  MatchedCaregiverRest,
  TaskSuggestion,
} from './dto/booking-rest.types';
import { resolveBookingTime } from './booking-time';
// PYG-526: เวลาสิ้นสุด/รูปแบบแสดงผลของใบจอง — ที่เดียวในระบบ
import { computeEndTime, formatStartTime } from './booking-time-display';
import { bookingHourlyRate } from '../common/pricing/display-price';
import { Prisma, booking_service_type, booking_status, time_slot } from '@prisma/client';
// PYG-524: นิยาม "ช่วงเวลาคาบเกี่ยว slot ไหนบ้าง" ต้องเป็นตัวเดียวกับที่ปฏิทินคิวว่าง
// รายวันของ PYG-493 ใช้ (common/constants/time-slot.constant.ts) ไม่งั้นปฏิทินกับการจอง
// จะตัดสิน slot คนละแบบ
import { overlappingSlots } from '../common/constants/time-slot.constant';
import { caregiverHasTimeConflict } from './caregiver-time-conflict';
import { activeHourlyPrice, estimatedCostOf } from '../common/pricing/service-price';
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
  MemberNameMissingError,
  PatientNameNotAllowedError,
} from '../family-group/family-group.errors';
import type { MemberDetailsInput } from '../family-group/dto/create-booking-on-behalf.input';
import { GroupBookingSummary } from '../family-group/entities/group-booking.entity';
// PYG-516/517: ชื่อตามบัญชี — ฟังก์ชันเดียวที่ทั้งระบบใช้
import {
  ACCOUNT_NAME_SELECT,
  accountDisplayName,
} from '../common/utils/account-name';
// PYG-434: ใบ QR ของงาน — สร้างพร้อม booking ใน transaction เดียวกัน
import { JobQrService } from '../monitoring/qr/job-qr.service';
// PYG-540: ถอนความยินยอมแล้วต้องจองใหม่ไม่ได้ / กลุ่มไม่เห็นนัดหมายของคนที่ถอน
import { ConsentService } from '../consent/consent.service';
import {
  BOOKING_ACTIVITIES_SELECT,
  CareActivityService,
  toBookingActivities,
  type BookingActivityRow,
} from '../care-activity/care-activity.service';
import { CareActivityError } from '../care-activity/care-activity.errors';
import {
  BOOKING_BLOCKING_CONSENTS,
  CONSENT_TYPE,
  ON_BEHALF_BLOCKING_CONSENTS,
} from '../consent/consent.constants';
import {
  consentWithdrawnError,
  consentWithdrawnHttpError,
} from '../consent/consent.errors';
// PYG-499: ผู้สูงอายุที่ยังไม่ผ่าน Onboarding สร้าง Booking ไม่ได้ (plain file ไม่มี DI)
import {
  ONBOARDING_GATE_SELECT,
  OnboardingRequiredError,
  isOnboardingRequired,
  onboardingRequiredHttpError,
} from '../identity/auth/onboarding-gate';

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
  familyGroupId: string | null;
  bookedBy: string | null;
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
  patientName: string | null;
  dayOfContactName: string | null;
  dayOfContactPhone: string | null;
  dayOfContactRelationship: string | null;
  memberDetails: unknown;
  // caregiver is nullable when booking is unmatched
  caregiver: {
    id: string;
    fullName: string | null;
    hourlyRate: number | null;
    averageRating: number | null;
    reviewCount: number | null;
    experienceYears: number | null;
    phone: string | null;
    user: { avatarUrl: string | null };
  } | null;
  careRecipient: { name: string } | null;
  /** PYG-634: สำเนากิจกรรม ณ ตอนจอง — มีเฉพาะ query ที่ include BOOKING_ACTIVITIES_SELECT / ตอนสร้าง */
  activities?: BookingActivityRow[];
};

/** จำนวนผู้ดูแลสูงสุดที่ searchMatchesBasic คืน (PYG-489: ขยายจาก 20) */
const MATCHES_LIMIT = 50;

/** คะแนนรีวิวเฉลี่ย (ทศนิยม 2 ตำแหน่ง) — undefined เมื่อยังไม่มีรีวิว */
function ratingOf(reviews: { rating: number }[]): { avgRating?: number; reviewCount: number } {
  const reviewCount = reviews.length;
  const avgRating =
    reviewCount > 0
      ? Math.round((reviews.reduce((s, r) => s + r.rating, 0) / reviewCount) * 100) / 100
      : undefined;
  return { avgRating, reviewCount };
}

// เบอร์ผู้ดูแลเปิดให้ผู้จองเห็นหลังยืนยันการจองแล้วเท่านั้น
const CAREGIVER_PHONE_VISIBLE_STATUSES = new Set([
  'confirmed', 'in_progress', 'completed',
]);

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
    // PYG-461 เฟส 3a: เงินตอนยกเลิกทั้งหมดอยู่ที่นี่ (แทน OmiseService + PaymentStateMachine
    // ที่ PYG-286 เคย inject ไว้ให้ cancelBooking void hold เอง — ดูตารางย้ายการ์ดที่ cancelBooking)
    private readonly settlementService: BookingSettlementService,
    // PYG-434: สร้างใบ QR เช็คอิน/เช็คเอาท์ พร้อมกับ booking ใน transaction เดียวกัน
    private readonly jobQrService: JobQrService,
    // PYG-540: ด่านความยินยอมก่อนจอง + กรองนัดหมายของกลุ่ม
    private readonly consentService: ConsentService,
    // PYG-518: sign avatarUrl ของผู้ดูแลก่อนส่งออก
    private readonly avatarUrlService: AvatarUrlService,
    // PYG-634: ตรวจ + บันทึกสำเนากิจกรรมที่เลือก (booking_activities) ใน transaction เดียวกับ booking
    private readonly careActivityService: CareActivityService,
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
    // PYG-499: ยังไม่ผ่าน Onboarding → 403 ONBOARDING_REQUIRED ไม่สร้างอะไรเลย
    // ★ อยู่ก่อนด่านความยินยอม — หน้า Onboarding ขอความยินยอมข้อมูลสุขภาพด้วยอยู่แล้ว (PYG-538)
    //   ส่งไปหน้านั้นหน้าเดียวจึงแก้ได้ทั้งสองเรื่อง ถ้าสลับกันผู้ใช้ต้องเดินสองรอบ
    // ★ REST ต้องโยน HttpException (มี statusCode) — ดู onboarding-gate.ts
    if (await this.needsOnboarding(patientId)) {
      this.logger.log({ event: 'booking.blocked_onboarding_required', patientId });
      throw onboardingRequiredHttpError();
    }

    // PYG-540: จองให้ตัวเอง/คนในความดูแล = เจ้าของข้อมูลคือ patient คนนี้เอง
    // ★ ตรวจก่อนเขียนอะไรทั้งหมด — ถอนไว้แล้วต้องไม่มีอะไรถูกเขียนลง DB เลย
    // ★ REST ต้องโยน HttpException (มี statusCode) ไม่ใช่ ConsentError — ดู consent.errors.ts
    const withdrawn = await this.consentService.findWithdrawnType(
      patientId,
      BOOKING_BLOCKING_CONSENTS,
    );
    if (withdrawn) {
      this.logger.log({
        event: 'booking.blocked_consent_withdrawn',
        patientId,
        consentType: withdrawn,
      });
      throw consentWithdrawnHttpError(withdrawn, true);
    }

    // PYG-634: CareActivityError เป็น GraphQLError — ทาง REST ต้องแปลงเป็น 422 ที่มี code ไม่งั้นได้ 500
    const booking = await this.createBookingRecord(patientId, dto).catch((err: unknown) => {
      throw err instanceof CareActivityError ? err.toRestError() : err;
    });
    await this.signCaregiverAvatars([booking]);
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
   *   ✓ เพดานความยาวของ medicines/allergies เท่ากันแล้วทั้งสองเส้นทาง (2000 ตัวอักษร)
   *     แก้ตาม PYG-464 follow-up (พบตอน QA ของ PYG-427 TC-BS-03/06, PYG-427_32) —
   *     ทั้งสอง DTO อ้างค่าคงที่ร่วมกันที่ patient/dto/patient-profile.constants.ts
   *     ห้ามฮาร์ดโค้ดตัวเลขแยกกันอีก ไม่งั้นจะเหลื่อมกันซ้ำ
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
      patientName?: string;     // PYG-516: ส่งมา = 400 — ชื่อมาจากบัญชีสมาชิกเท่านั้น
      memberDetails?: MemberDetailsInput;
    },
  ): Promise<BookingSummary> {
    // PYG-516 (ฟีดแบ็กอาจารย์ Sprint 9 ข้อ 6 / PYG-495)
    //   ชื่อ-นามสกุลของผู้รับบริการเป็น "ตัวตน" ของเจ้าของบัญชี คนจองแทนพิมพ์ทับไม่ได้
    // Apply before every recipient path and before writing bookings.patient_name.
    if (input.patientName !== undefined) {
      throw new PatientNameNotAllowedError();
    }

    // PYG-499: คนกดจอง (ผู้เรียก) เป็นผู้สูงอายุที่ยังไม่ผ่าน Onboarding → ONBOARDING_REQUIRED
    //   ★ ตรวจ "คนกดจอง" ไม่ใช่สมาชิกที่ถูกจองให้ — การ์ดกันผู้เรียกที่ข้ามหน้า Onboarding
    //     S08 additionally requires a persisted, assessed recipient profile.
    //   ★ อยู่ก่อนอ่านข้อมูลกลุ่ม/โปรไฟล์ใด ๆ — ไม่ผ่านด่านก็ไม่มีเหตุให้ไปอ่านข้อมูลสุขภาพของใคร
    //   ★ GraphQL ต้องโยน GraphQLError (extensions.code) — ดู onboarding-gate.ts
    if (await this.needsOnboarding(bookerId)) {
      this.logger.log({
        event: 'booking.on_behalf_blocked_onboarding_required',
        groupId: input.groupId,
        bookerId,
      });
      throw new OnboardingRequiredError();
    }

    // สิทธิ์ "ผู้เรียกเป็นสมาชิก ACTIVE ของกลุ่มนี้" ถูกตรวจโดย FamilyGroupGuard มาแล้ว
    // ที่นี่เหลือการ resolve ว่า booking ใบนี้ผูกกับโปรไฟล์ผู้รับบริการใบไหน (careRecipientId)
    let recipientId: string | undefined;
    let recipientName: string;

    if (input.memberUserId && input.careRecipientId) {
      const membership = await this.prisma.familyGroupMember.findFirst({
        where: { groupId: input.groupId, userId: input.memberUserId, status: 'ACTIVE' },
        select: { userId: true },
      });
      if (!membership) throw new MemberNotFoundError();

      // PYG-540: เจ้าของข้อมูล = สมาชิกคนนี้ · ตรวจหลังยืนยันสมาชิก และก่อนอ่านโปรไฟล์สุขภาพ
      // (เส้นทางนี้ใช้ได้กับโปรไฟล์ส่วนตัวด้วย — ถอนข้อ family group แล้วต้องไม่ถูกดึงเข้ากลุ่ม)
      await this.assertOnBehalfConsents(input.memberUserId, bookerId, input.groupId);

      const recipient = await this.prisma.careRecipient.findFirst({
        where: {
          id: input.careRecipientId,
          patientId: input.memberUserId,
          is_deleted: false,
          OR: [{ familyGroupId: null }, { familyGroupId: input.groupId }],
        },
        select: { id: true, name: true },
      });
      if (!recipient) throw new RecipientNotInGroupError();
      recipientId = recipient.id;
      recipientName = recipient.name;
    } else if (input.memberUserId) {
      // Resolve the existing profile for this member; S08 blocks provisioning during booking.
      const resolved = await this.resolveGroupPatientProfile(
        input.groupId,
        input.memberUserId,
        bookerId,
      );
      recipientId = resolved.id;
      recipientName = resolved.name;
    } else if (input.careRecipientId) {
      // เส้นทางเดิม (PYG-424): อ้างโปรไฟล์ที่แชร์ในกลุ่มตรง ๆ
      // ไม่มีโปรไฟล์ หรือมีแต่เป็นของกลุ่มอื่น/เป็นโปรไฟล์ส่วนตัว → ตอบ error เดียวกัน (กันเดา id)
      const recipient = await this.prisma.careRecipient.findUnique({
        where: { id: input.careRecipientId },
        // PYG-540: patientId = เจ้าของข้อมูล — ใช้ทั้งเช็คสมาชิก ACTIVE (PYG-516) และตรวจความยินยอม
        select: {
          id: true,
          name: true,
          familyGroupId: true,
          patientId: true,
          is_deleted: true,
        },
      });
      if (
        !recipient ||
        recipient.familyGroupId !== input.groupId ||
        recipient.is_deleted
      ) {
        throw new RecipientNotInGroupError();
      }

      // PYG-516 — เดิมตรวจแค่ "โปรไฟล์อยู่ในกลุ่มนี้" คนที่ออกจากกลุ่ม/ถูกเตะไปแล้ว
      //   จึงยังถูกจองแทนได้ตลอดกาล เพราะโปรไฟล์ยังค้างอยู่ในกลุ่ม
      //   ★ ตอบ RecipientNotInGroupError ตัวเดิม ไม่ใช่ error ใหม่ — ไม่งั้นคนยิง id มั่ว ๆ
      //     จะไล่ดูได้ว่าใบไหน "มีอยู่แต่เจ้าของออกจากกลุ่มแล้ว" ซึ่งไม่ควรรั่ว
      const ownerActive = await this.prisma.familyGroupMember.findFirst({
        where: {
          groupId: input.groupId,
          userId: recipient.patientId,
          status: 'ACTIVE',
        },
        select: { userId: true },
      });
      if (!ownerActive) throw new RecipientNotInGroupError();

      // PYG-540: ตรวจ "หลัง" ยืนยันว่าโปรไฟล์อยู่ในกลุ่มและเจ้าของยังเป็นสมาชิกแล้วเท่านั้น
      // ไม่งั้นคนนอกกลุ่มส่ง id มั่ว ๆ เพื่อแอบดูว่าใครถอนความยินยอมได้
      await this.assertOnBehalfConsents(recipient.patientId, bookerId, input.groupId);
      recipientId = recipient.id;
      recipientName = recipient.name;
    } else {
      // ไม่ได้ส่งทั้งคู่ — ต้องระบุว่าจองแทน "ใคร"
      throw new RecipientNotInGroupError();
    }

    const booking = await this.createBookingRecord(
      bookerId,
      // PYG-516: bookings.patient_name คือชื่อที่ผู้ดูแลเห็นบนใบงาน — ต้องเป็นชื่อจากโปรไฟล์
      // ที่ resolve มาแล้ว ไม่ใช่ค่าที่คนจองพิมพ์ (ซึ่งตอนนี้ส่งมาไม่ได้อยู่แล้ว)
      { ...input, careRecipientId: recipientId, patientName: recipientName },
      {
        familyGroupId: input.groupId,
        bookedBy: bookerId,
        recipientName,
        // PYG-385: undefined เมื่อไม่ได้กรอก — createBookingRecord จะไม่แตะคอลัมน์ให้ (คง NULL)
        memberDetails: input.memberDetails,
      },
    );

    await this.signCaregiverAvatars([booking]);
    return this.toSummary(booking);
  }

  /** Resolve an existing shared profile; S08 requires it to be assessed before
   * booking. A missing profile is never provisioned or copied by booking now. */
  private async resolveGroupPatientProfile(
    groupId: string,
    memberUserId: string,
    bookerId: string,
  ): Promise<{
    id?: string;
    name: string;
  }> {
    // subject ต้องเป็นสมาชิก ACTIVE ของกลุ่มนี้ (guard ตรวจแค่ "ผู้เรียก" ไม่ได้ตรวจ "คนที่ถูกจองให้")
    const membership = await this.prisma.familyGroupMember.findFirst({
      where: { groupId, userId: memberUserId, status: 'ACTIVE' },
      select: { userId: true },
    });
    if (!membership) throw new MemberNotFoundError();

    // Preserve existing consent checks before looking up a shared profile.
    // ★ อยู่หลังเช็คสมาชิก — คนนอกกลุ่มจะใช้ error นี้แอบดูความยินยอมของใครไม่ได้
    await this.assertOnBehalfConsents(memberUserId, bookerId, groupId);

    // ① โปรไฟล์ในกลุ่มที่มีอยู่แล้ว
    const existing = await this.prisma.careRecipient.findFirst({
      where: { patientId: memberUserId, familyGroupId: groupId, is_deleted: false },
      select: { id: true, name: true },
      orderBy: { updated_at: 'desc' },
    });
    if (existing) return existing;

    return { name: await this.resolveMemberAccountName(memberUserId) };
  }


  /**
   * PYG-516 — ชื่อผู้รับบริการ "ตามบัญชี" ของสมาชิกที่ถูกจองแทน
   *
   * ลำดับ: `first_name last_name` (จาก Onboarding PYG-496/497) → ไม่มีก็ `display_name`
   *   บัญชีเก่าที่สมัครก่อน Onboarding มีแต่ display_name จาก provider — ยังจองแทนได้
   *
   * ★ ไม่มีทั้งคู่ → MemberNameMissingError ไม่ใช่ fallback เป็น "ผู้ใช้ #xxxx"
   *   ใบงานที่ผู้ดูแลถือไปต้องระบุตัวคนที่จะไปดูแลได้จริง ชื่อหลอกอันตรายกว่าการจองไม่ผ่าน
   */
  private async resolveMemberAccountName(memberUserId: string): Promise<string> {
    const account = await this.prisma.user.findUnique({
      where: { id: memberUserId },
      select: ACCOUNT_NAME_SELECT,
    });

    // PYG-517 ใช้ฟังก์ชันเดียวกันนี้โชว์บนปุ่ม shortcut — ถ้าคำนวณคนละแบบ
    // ผู้ใช้จะกดชื่อหนึ่งแล้วใบจองขึ้นอีกชื่อหนึ่ง
    const name = accountDisplayName(account);
    if (!name) throw new MemberNameMissingError();
    return name;
  }

  /**
   * PYG-499 — ผู้เรียกเป็นผู้สูงอายุ (role 1) ที่ยังไม่ผ่าน Onboarding หรือไม่
   *
   * คืน boolean แทนการโยนเอง เพราะแต่ละเส้นทางต้องโยน error คนละแบบ
   * (REST = HttpException · GraphQL = GraphQLError) — เกณฑ์เต็มอยู่ที่ onboarding-gate.ts
   */
  private async needsOnboarding(userId: string): Promise<boolean> {
    const account = await this.prisma.user.findUnique({
      where: { id: userId },
      select: ONBOARDING_GATE_SELECT,
    });
    return isOnboardingRequired(account);
  }

  /**
   * PYG-540 — ด่านความยินยอมของ "เจ้าของข้อมูล" ก่อนจองแทนในกลุ่มครอบครัว
   *
   * ★ ตรวจเจ้าของข้อมูล (subject) ไม่ใช่คนกดจอง — ความยินยอมเป็นของคนที่ข้อมูลสุขภาพจะถูกใช้
   *   คนกดจองถอนของตัวเองไว้ก็ไม่เกี่ยวกับการจองให้คนอื่น
   * ★ ถอนข้อใดข้อหนึ่งใน ON_BEHALF_BLOCKING_CONSENTS → โยน CONSENT_WITHDRAWN
   *   ยังไม่เคยตอบ = ผ่าน (ดูเหตุผลที่ findWithdrawnType)
   */
  private async assertOnBehalfConsents(
    subjectId: string,
    bookerId: string,
    groupId: string,
  ): Promise<void> {
    const withdrawn = await this.consentService.findWithdrawnType(
      subjectId,
      ON_BEHALF_BLOCKING_CONSENTS,
    );
    if (!withdrawn) return;

    this.logger.log({
      event: 'booking.on_behalf_blocked_consent_withdrawn',
      groupId,
      bookerId,
      subjectId,
      consentType: withdrawn,
    });
    throw consentWithdrawnError(withdrawn, subjectId === bookerId);
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
    // PYG-523 — ตรวจ/คำนวณเวลาก่อนอย่างอื่นทั้งหมด (ยังไม่มีอะไรถูกเขียนลง DB)
    //   ค่าด้านล่างทุกจุด (ราคา / เวลาชน / แถวที่บันทึก) ต้องใช้ time.* ไม่ใช่ dto.* ตรง ๆ
    //   เพราะแบบใหม่ client ไม่ได้ส่ง durationHours / timeSlot มาเลย
    const time = resolveBookingTime(dto);

    // ตรวจสอบ careRecipientId ถ้าส่งมา — ต้องเป็นของ patient คนนี้
    //
    // PYG-424: ข้ามเช็คนี้เมื่อเป็นการจองแทน เพราะโปรไฟล์เป็นของ "สมาชิกคนอื่น"
    // ในกลุ่มโดยธรรมชาติ → เช็คแบบเดิมจะปฏิเสธการจองแทนทุกใบ
    // ความปลอดภัยไม่ได้หายไป แค่เปลี่ยนเกณฑ์: createBookingOnBehalf ตรวจว่า
    // "โปรไฟล์อยู่ในกลุ่มเดียวกับผู้เรียก" มาก่อนแล้ว ซึ่งเข้มพอกัน
    if (dto.careRecipientId && !onBehalf) {
      const recipient = await this.prisma.careRecipient.findUnique({
        where: { id: dto.careRecipientId },
        select: { patientId: true, is_deleted: true },
      });
      if (!recipient || recipient.is_deleted) throw new NotFoundException('Care recipient not found');
      if (recipient.patientId !== patientId)
        throw new ForbiddenException('Care recipient does not belong to this patient');
    }

    const newStart = time.startMinute;
    const newEnd = newStart + Math.round(time.durationHours * 60);
    const bookingDateObj = new Date(dto.bookingDate + 'T00:00:00.000Z');

    // ฟีดแบ็กอาจารย์ Sprint 9 ข้อ 2: ราคาจาก service_price_catalog ตาม serviceType
    // ไม่ขึ้นกับผู้ดูแล → ใบ unmatched ก็มีราคาแล้ว · ประเภทที่ยังไม่เปิดขาย = 422 ไม่สร้างใบจอง
    // ยอดนี้คือยอดที่ PaymentService ตัดจริง (ไม่คิดใหม่ตอนจ่าย)
    const estimatedCost = estimatedCostOf(
      await activeHourlyPrice(this.prisma, dto.serviceType),
      time.durationHours,
    );

    // ตรวจสอบ caregiverId ถ้าส่งมา — ต้องเป็น verified + searchable caregiver
    let resolvedCaregiverId: string | null = null;
    if (dto.caregiverId) {
      const caregiver = await this.prisma.caregiver.findUnique({
        where: { id: dto.caregiverId },
        select: { id: true, kycStatus: true, isSearchable: true },
      });
      if (!caregiver || caregiver.kycStatus !== 'verified' || !caregiver.isSearchable) {
        throw new NotFoundException('Caregiver not found or unavailable');
      }
      resolvedCaregiverId = caregiver.id;

      /**
       * PYG-524 — เช็ค caregiver_availability จริง แทนการเชื่อ timeSlot ที่ client ส่งมาเฉย ๆ
       *
       * ของเดิม: createBooking เก็บ dto.timeSlot ลงใบจองตรง ๆ ไม่เคยเทียบกับตารางว่างของ
       * ผู้ดูแลเลย (search.service.ts ก็เช็คแค่ "มี slot active อย่างน้อย 1 ช่อง" ไม่ดูวัน/เวลา)
       * → จองผู้ดูแลในวัน/ช่วงที่เขาไม่ได้เปิดรับได้อยู่เสมอมา
       *
       * เกณฑ์: ต้องมี caregiver_availability ที่ is_active ใน dayOfWeek ของวันจอง
       * ครบทุก slot ที่ช่วงเวลาคาบเกี่ยว (overlappingSlots) — ขาดแม้ slot เดียวก็ไม่ผ่าน
       * เพราะช่วงที่คร่อม 2 slot (เช่น 11:00–14:00) ต้องว่างทั้งคู่ ไม่ใช่แค่ slot ที่เวลาเริ่มอยู่
       *
       * ใช้ overlappingSlots ตัวเดียวกับปฏิทินคิวว่างรายวันของ PYG-493
       * (common/constants/time-slot.constant.ts) เพื่อให้ปฏิทินกับการจองตัดสิน slot ตรงกัน
       */
      const dayOfWeek = bookingDateObj.getUTCDay();
      const requiredSlots = overlappingSlots(newStart, newEnd);

      const activeSlots = await this.prisma.caregiverAvailability.findMany({
        where: {
          caregiverId: resolvedCaregiverId,
          dayOfWeek,
          isActive: true,
          timeSlot: { in: requiredSlots as time_slot[] },
        },
        select: { timeSlot: true },
      });
      const coveredSlots = new Set(activeSlots.map((slot) => slot.timeSlot));

      if (!requiredSlots.every((slot) => coveredSlots.has(slot))) {
        throw new ConflictException('ผู้ดูแลไม่ได้เปิดรับงานในช่วงเวลานี้');
      }

      /**
       * PYG-544 — ตารางว่างรายสัปดาห์ข้างบนไม่รู้ว่าวันนั้นผู้ดูแลรับงานของคนอื่นไปแล้วหรือยัง
       * → เช็คกับใบจองที่ผู้ดูแลรับไว้แล้วด้วย (ไม่นับ pending ดู CAREGIVER_BUSY_STATUSES)
       *
       * ไม่ล็อกแถวผู้ดูแลตรงนี้: ใบใหม่เกิดเป็น pending ซึ่งไม่กันเวลาของใคร ถ้าผู้ดูแลกดรับ
       * อีกใบในจังหวะเดียวกัน ใบนี้จะถูกกันที่ acceptBooking ซึ่งเป็นด่านที่ล็อกจริง
       */
      const caregiverBusy = await caregiverHasTimeConflict(this.prisma, {
        caregiverId: resolvedCaregiverId,
        bookingDate: bookingDateObj,
        startMinute: newStart,
        endMinute: newEnd,
      });
      if (caregiverBusy) {
        throw new ConflictException('ผู้ดูแลไม่ว่างในช่วงเวลานี้ กรุณาเลือกเวลาอื่นหรือผู้ดูแลท่านอื่น');
      }
    }

    // ── ตรวจสอบ time conflict ──────────────────────────────────────────────────
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
     *
     * S08: จองแทนที่ยังไม่มีโปรไฟล์ → ข้ามเช็คเวลาชน แล้วปฏิเสธที่ assessment gate
     *   และถ้าปล่อยไหลลง { patientId } จะกลายเป็นเช็คนัดของ "คนกดจอง" แทนผู้รับบริการ
     */
    const conflictScope = dto.careRecipientId
      ? { careRecipientId: dto.careRecipientId }
      : { patientId };

    const conflicts = onBehalf && !dto.careRecipientId
      ? []
      : await this.prisma.booking.findMany({
          where: {
            ...conflictScope,
            bookingDate: bookingDateObj,
            // 'accepted' = caregiver กดรับงานแล้ว รอผู้ป่วยยืนยัน/จ่ายเงิน — ยังมีผลอยู่
            // เหมือน pending/confirmed ไม่ใช่ draft ที่ยกเลิกเองได้เงียบ ๆ (ดู caregiver-booking.service.ts)
            // ของเดิมไม่นับ → จองซ้อนกับใบที่ผู้ดูแลรับไปแล้วได้
            status: { in: ['pending', 'accepted', 'confirmed'] },
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

    // PYG-361: booking_tasks เป็นแหล่งข้อมูลใหม่สำหรับ per-task completion state
    // (bookings.tasks ด้านล่างยังเขียนไว้เหมือนเดิม ไม่ถูกลบ — legacy display field ที่ตอนนี้
    // ไม่ใช่แหล่งเดียวอีกต่อไป) ต้องอยู่ใน transaction เดียวกับ booking.create: ถ้า insert แถว
    // task ล้ม ต้อง rollback booking ด้วย ไม่งั้นจะได้ booking ที่มี tasks (TEXT[]) แต่
    // booking_tasks ว่างเปล่า → หน้าติดตามงานของ PYG-361 จะโชว์ "0 จาก 0 รายการ" ทั้งที่จองมี task จริง
    const suggestedForType = TASK_SUGGESTIONS[dto.serviceType] ?? [];

    const data: Prisma.BookingUncheckedCreateInput = {
      patientId,
      caregiverId:      resolvedCaregiverId,
      careRecipientId:  dto.careRecipientId ?? null,
      tasks:            dto.tasks,
      serviceLocations: dto.serviceLocations,
      serviceType:      dto.serviceType as booking_service_type,
      timeSlot:         time.timeSlot as time_slot,
      startTime:        new Date(`1970-01-01T${time.startTime}Z`),
      durationHours:    time.durationHours,
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
     * ② PYG-361 — แถว booking_tasks ต่อ 1 task (per-task completion state; bookings.tasks
     *    ด้านบนยังเขียนไว้เหมือนเดิม เป็น legacy display field ที่ไม่ใช่แหล่งเดียวอีกต่อไป)
     * ③ PYG-424 — ฟีดกิจกรรมของกลุ่ม (เฉพาะตอนจองแทน)
     *    กติกาข้อ 2 ของโมดูล family group (ดูหัวไฟล์ family-group.service.ts)
     *    ถ้าเขียนแยกกันแล้วอันใดอันหนึ่งพัง จะได้ฟีดที่โกหกว่ามีการจองที่ไม่เคยเกิดขึ้น
     *    หรือมีการจองที่ไม่โผล่ในฟีดเลย ซึ่งทั้งสองแบบตรวจสอบย้อนหลังไม่ได้
     * ④ PYG-434 — ใบ QR สำหรับเช็คอิน/เช็คเอาท์ (ทุกใบ ไม่มีข้อยกเว้น)
     *
     * ⚠ ก่อนหน้านี้ "จองปกติ" ใช้ create เดี่ยว ๆ เพื่อไม่จ่ายค่า transaction ฟรี ๆ
     *   PYG-434 เปลี่ยนให้ใช้ transaction ทุกเส้นทาง เพราะ AC เขียนว่า
     *   "ทุก booking ใหม่มี JobSession PENDING + token" — คำว่า "ทุก" จะเป็นจริงได้
     *   ก็ต่อเมื่อ booking กับ QR เกิดหรือไม่เกิดพร้อมกันเท่านั้น
     *   ถ้าสร้างแยกกันแล้วขั้นที่สองพัง จะเหลือ booking ที่เช็คอินไม่ได้ตลอดไป
     *   และไม่มีอะไรในระบบคอยตามซ่อมให้ — ค่า transaction หนึ่งครั้งถูกกว่ามาก
     */
    const booking = await this.prisma.$transaction(async (tx) => {
      // S08: legacy name-only/new-profile flows must assess a persisted profile
      // first. Do not create one here or copy another profile's assessment.
      await assertBookingAssessment(tx, data.careRecipientId, onBehalf ? 'graphql' : 'rest');
      const activities = await this.careActivityService.resolveForBooking(tx, dto.activityIds);

      const created = await tx.booking.create({ data, include });

      // ⑤ PYG-634: สำเนาชื่อ หมวด ระดับ ณ ตอนจอง (R6) — งานพิมพ์เอง (tasks) ไม่ถูกเขียนที่นี่ (AC6)
      await this.careActivityService.writeForBooking(tx, created.id, activities);
      await recalculateBookingRequiredSkills(tx, created.id, onBehalf ? 'graphql' : 'rest');

      // ② PYG-361: booking_tasks ต่อ 1 task — อยู่ใน transaction เดียวกับ booking.create
      // เพื่อไม่ให้เกิด booking ที่มี tasks (TEXT[]) แต่ booking_tasks ว่างเปล่า
      await tx.booking_tasks.createMany({
        data: dto.tasks.map((description, index) => ({
          booking_id:   created.id,
          description,
          is_suggested: suggestedForType.includes(description),
          is_custom:    !suggestedForType.includes(description),
          sort_order:   index,
        })),
      });

      // ③ จองแทนเท่านั้น — จองปกติไม่มีกลุ่มให้บันทึก
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
              startTime:     time.startTime,
            },
          },
        });
      }

      // ④ ใบ QR — คำนวณช่วงเวลาที่สแกนได้จากตารางงานของ booking ที่เพิ่งสร้าง
      //    ส่ง tx เข้าไปเพื่อให้อยู่ใน transaction เดียวกัน (service บังคับรับ tx)
      await this.jobQrService.createForBooking(tx, created);

      return Object.assign(created, { activities });
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
   * Patient ยกเลิก booking ของตัวเอง — PYG-461 เฟส 3a
   *
   * เมธอดนี้เหลือหน้าที่ "สิทธิ์ + แจ้งเตือนระดับ booking" เท่านั้น
   * เรื่องเงินทั้งหมดย้ายไป `BookingSettlementService.settle()` (เฟส 2)
   *
   * ★ การ์ดเงินที่ถูกลบจากตรงนี้ ย้ายไปอยู่ที่ไหน (ไม่มีตัวไหนหายไปเฉย ๆ):
   *
   *   `cancellableStatuses = [unmatched, pending, accepted]`
   *     → `SETTLEABLE_FROM[PATIENT_CANCEL]` ซึ่ง **เพิ่ม 'confirmed'** เข้าไป — คือตัวบั๊กของ PYG-461
   *       (payment เป็น held/captured ได้เฉพาะตอน booking = confirmed → ด่านเดิมบล็อกไว้หมด
   *        โค้ด void ของ PYG-286 จึงไม่เคยทำงานจริงเลย) · นอกรายการ → 422 booking_not_settleable
   *
   *   `shouldVoid` (held + มี omiseChargeId) → `omiseService.voidCharge` นอก tx
   *     → matrix ของ settle: held → void ที่ Omise **ใต้ row lock ใน tx เดียวกัน**
   *       พร้อม Omise-Idempotency-Key (กัน void ซ้ำเมื่อ tx rollback หลัง Omise สำเร็จ)
   *
   *   `catch → ServiceUnavailableException` (Omise พัง = ไม่ยกเลิก booking)
   *     → settle: Omise fail = rollback ทั้งก้อน booking ไม่เปลี่ยนสถานะ + 422 omise_unreachable
   *       ที่ retryable = true · การรับประกัน "ไม่มีทาง cancelled ทั้งที่เงินยังไม่คืน" แข็งขึ้น
   *       เพราะเดิม void สำเร็จแล้ว tx ล้ม = วงเงินถูกปล่อยแต่ booking ยังค้าง
   *
   *   `fsm.transition(payment → voided)` ใน tx
   *     → settle ทำใน tx เดียวกับ booking.update + เขียน booking_status_history ด้วย
   *
   *   `eventEmitter.emit(PAYMENT_VOIDED)`
   *     → settle ยิงเองหลัง commit (พร้อม REFUND_ISSUED ที่เดิมไม่มี)
   *
   *   ที่เดิม **ไม่มี** และเพิ่มเข้ามาจาก settle:
   *     captured (PromptPay จ่ายจริงแล้ว) → RefundService.refund() ตาม CANCELLATION_POLICY
   *       — เดิมยกเลิกผ่านโดยไม่คืนเงิน คือข้อที่การ์ดเรียกว่า "ผู้ป่วยเสียเงินฟรี"
   *     pending (PromptPay ยังไม่สแกน) → ถาม Omise ก่อน แล้วปิด charge ให้ webhook ตามมาทีหลังไม่ได้
   *     refunded / partially_refunded / transferred และ payout ที่จ่ายแล้ว → 422 ไม่ปล่อยผ่าน
   *
   * ★ สิ่งที่ settle **ไม่** ทำ และต้องอยู่ที่นี่ต่อ: ตรวจว่าเป็น booking ของผู้เรียกจริง
   *   settle ไม่รู้จักเจ้าของ (cron ก็เรียกได้) → ถ้าย้ายออกไปด้วยจะกลายเป็นใครก็ยกเลิกของใครก็ได้
   */
  async cancelBooking(bookingId: string, patientId: string): Promise<BookingRest> {
    const booking = await this.prisma.booking.findUnique({
      where: { id: bookingId },
      select: { id: true, patientId: true },
    });

    if (!booking) throw new NotFoundException('Booking not found');
    if (booking.patientId !== patientId)
      throw new ForbiddenException('Access denied');

    // เงิน + สถานะ booking + audit ทั้งหมดอยู่ใน settle() — โยน 422/404 ที่อ่านรู้เรื่องเองเมื่อยกเลิกไม่ได้
    const settlement = await this.settlementService.settle(
      bookingId,
      SettlementReason.PATIENT_CANCEL,
      { id: patientId, role: 'patient' },
    );

    // อ่านใหม่หลัง settle — แถวเพิ่งเปลี่ยนสถานะไป ถ้าใช้ของที่อ่านก่อนหน้าจะคืน status เก่าให้ FE
    const updated = await this.prisma.booking.findUniqueOrThrow({
      where: { id: bookingId },
      include: {
        caregiver:     { include: { user: { select: { avatarUrl: true } } } },
        careRecipient: { select: { name: true } },
        activities:    BOOKING_ACTIVITIES_SELECT, // PYG-634
      },
    });

    this.logger.log({
      event: 'booking.cancelled',
      bookingId,
      patientId,
      moneyAction: settlement.moneyAction,
      refundAmount: settlement.refundAmount,
      alreadySettled: settlement.alreadySettled,
    });

    // PYG-292: แจ้ง caregiver ว่าผู้ใช้บริการยกเลิกการจอง
    // ★ เรียกซ้ำ (alreadySettled) → ไม่ยิงซ้ำ ไม่งั้นผู้ดูแลได้แจ้งเตือน "ถูกยกเลิก" หลายรอบจากใบเดียว
    //   PAYMENT_VOIDED / REFUND_ISSUED ไม่ต้องยิงที่นี่ — settle ยิงให้แล้วหลัง commit
    if (!settlement.alreadySettled) {
      this.emit({
        bookingId,
        eventType: BOOKING_EVENTS.CANCELLED,
        patientId,
        caregiverId: updated.caregiver?.userId ?? null,
      });
    }

    await this.signCaregiverAvatars([updated as unknown as BookingWithIncludes]);
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
   *
   * ลำดับ (PYG-489): คะแนนรีวิวเฉลี่ยจากมากไปน้อย ผู้ดูแลที่ยังไม่มีรีวิวอยู่ท้าย
   *   คะแนนเท่ากัน (หรือไม่มีรีวิวเหมือนกัน) → สมัครก่อนอยู่ก่อน (created_at เก่าไปใหม่)
   *   เดิมเรียงตาม caregivers.hourly_rate ASC — ผู้ดูแลตั้งราคาเองไม่ได้แล้ว คนใหม่ทุกคนเป็น null
   *   จึงถูกเรียงไว้ท้ายสุดและหลุดจากรายการเมื่อเกินจำนวนที่ตัด ทั้งที่ราคาที่ลูกค้าจ่ายเท่ากันทุกคน
   * ตัดที่ MATCHES_LIMIT คนหลังเรียงแล้ว
   *
   * ⚠ เรียงในหน่วยความจำ: Prisma เรียงตามค่าเฉลี่ยของ relation ไม่ได้ จึงดึงผู้ดูแลที่เข้าเงื่อนไขมาทั้งหมดก่อน
   *   จำนวนยังน้อย (หลักสิบ) — ถ้าโตถึงหลักพันให้ย้ายไปเรียงใน SQL · รอ matching engine
   *
   * ราคาที่คืน = ราคา catalog ของ dto.serviceType (ฟีดแบ็กอาจารย์ Sprint 9 ข้อ 2) — เท่ากับยอดที่จะคิดตอนจองจริง
   */
  async searchMatchesBasic(dto: SearchMatchesDto): Promise<MatchedCaregiverRest[]> {
    const where: Record<string, unknown> = {
      isSearchable: true,
      kycStatus:    'verified',
    };

    if (dto.province) {
      where.serviceAreaProvince = dto.province;
    }

    const candidates = await this.prisma.caregiver.findMany({
      where,
      select: {
        id:                   true,
        fullName:             true,
        createdAt:            true,
        experienceYears:      true,
        skills:               true,
        otherSkills:          true,
        serviceAreaProvince:  true,
        serviceAreaDistrict:  true,
        patientReviews:       { select: { rating: true } },
        user:                 { select: { avatarUrl: true } },
      },
      // ลำดับตั้งต้นให้ผลคงที่ — ลำดับจริงเรียงด้านล่าง
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });

    const caregivers = candidates
      .map((cg) => ({ cg, ...ratingOf(cg.patientReviews) }))
      .sort(
        (a, b) =>
          (b.avgRating ?? -1) - (a.avgRating ?? -1) ||
          a.cg.createdAt.getTime() - b.cg.createdAt.getTime() ||
          a.cg.id.localeCompare(b.cg.id),
      )
      .slice(0, MATCHES_LIMIT);

    const catalogRow = await this.prisma.servicePriceCatalog.findUnique({
      where: { serviceType: dto.serviceType },
      select: { pricePerHour: true, isActive: true },
    });
    const servicePrice =
      catalogRow?.isActive ? Number(catalogRow.pricePerHour) : undefined;

    // PYG-518: เซ็น avatar ของ caregiver ทั้ง 20 รายในการเรียกเดียว ไม่ยิงทีละคน
    const avatarByCaregiver = await this.avatarUrlService.resolveMany(
      caregivers.map(({ cg }) => cg),
      (cg) => cg.user.avatarUrl,
    );

    return caregivers.map(({ cg, avgRating, reviewCount }) => {
      return {
        id:              cg.id,
        fullName:        cg.fullName        ?? undefined,
        avatarUrl:       avatarByCaregiver.get(cg) ?? undefined,
        hourlyRate:      servicePrice,
        experienceYears: cg.experienceYears ?? undefined,
        skills:          cg.skills,
        otherSkills:     cg.otherSkills,
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
        activities:    BOOKING_ACTIVITIES_SELECT, // PYG-634
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

    await this.signCaregiverAvatars([updated as unknown as BookingWithIncludes]);
    return {
      booking: await this.toRestSummary(updated as unknown as BookingWithIncludes),
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

    const updated = await this.prisma.$transaction(async (tx) => {
      if (booking.careRecipientId) await lockRequiredSkillRecipient(tx, booking.careRecipientId);
      await tx.$queryRaw`SELECT id FROM bookings WHERE id = ${bookingId}::uuid FOR UPDATE`;
      const current = await tx.booking.findUnique({ where: { id: bookingId } });
      if (!current) throw new NotFoundException('Booking not found');
      if (current.patientId !== userId) throw new ForbiddenException('Access denied');
      if (current.status !== 'accepted') throw new UnprocessableEntityException('Only bookings with status "accepted" can be confirmed');
      // Legacy bookings without a recipient keep their unknown skill snapshot.
      if (current.careRecipientId) await recalculateBookingRequiredSkills(tx, bookingId);
      return tx.booking.update({
        where: { id: bookingId },
        data: { status: 'confirmed', confirmedAt: new Date() },
        include: {
          caregiver: { include: { user: { select: { avatarUrl: true } } } },
          careRecipient: { select: { name: true } },
        },
      });
    });

    this.logger.log({ event: 'booking.confirmed', bookingId, userId });
    await this.signCaregiverAvatars([updated as unknown as BookingWithIncludes]);
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
    await this.signCaregiverAvatars([booking as unknown as BookingWithIncludes]);
    const summary = this.toSummary(booking as unknown as BookingWithIncludes);
    if (summary.caregiver && booking.caregiverId) {
      summary.caregiver.completedJobs = await this.prisma.booking.count({
        where: { caregiverId: booking.caregiverId, status: 'completed' },
      });
    }
    return summary;
  }

  /**
   * รายละเอียดคำจองในมุมมองกลุ่มครอบครัว.
   * FamilyGroupGuard ตรวจสมาชิกภาพ ACTIVE ก่อนเข้ามาถึงเมธอดนี้ ส่วนเงื่อนไข
   * familyGroupId ป้องกันการนำ booking id จากกลุ่มอื่นมาอ่านผ่าน groupId ที่ตนเป็นสมาชิก.
   */
  async groupBookingById(
    bookingId: string,
    groupId: string,
    userId: string,
  ): Promise<BookingSummary> {
    const booking = await this.prisma.booking.findUnique({
      where: { id: bookingId },
      include: {
        caregiver:     { include: { user: { select: { avatarUrl: true } } } },
        careRecipient: { select: { name: true } },
      },
    });

    // คืน NotFound ทั้งกรณีไม่มี booking และ booking อยู่คนละกลุ่ม เพื่อไม่เปิดเผยข้อมูลข้ามกลุ่ม
    if (!booking || booking.familyGroupId !== groupId) {
      throw new NotFoundException('Booking not found');
    }

    await this.signCaregiverAvatars([booking as unknown as BookingWithIncludes]);
    const summary = this.toSummary(booking as unknown as BookingWithIncludes);
    summary.bookedByMe = booking.bookedBy === userId || booking.patientId === userId;
    if (summary.caregiver && booking.caregiverId) {
      summary.caregiver.completedJobs = await this.prisma.booking.count({
        where: { caregiverId: booking.caregiverId, status: 'completed' },
      });
    }
    return summary;
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

    //   เฉพาะการจองส่วนตัว — ใบ "จองแทน" มี patientId = คนกดจองด้วย (เพื่อให้จ่ายเงินได้ ดู
    //   createBookingOnBehalf) ถ้าไม่กรอง นัดของสมาชิกในครอบครัวจะปนมาใน "นัดหมายของฉัน"
    //   ใบจองแทนดู/จ่ายเงิน/จัดการได้ที่หน้ากลุ่มครอบครัว (groupBookings + BookingDetail โหมดกลุ่ม)
    //   ผลพลอยได้: ที่อยู่ล่าสุดที่เติมให้ตอนจองครั้งถัดไป (GET_LATEST_BOOKING_ADDRESS)
    //   ไม่หยิบที่อยู่บ้านสมาชิกมาเป็นที่อยู่ของเราอีก
    const where: Record<string, unknown> = { patientId: userId, familyGroupId: null };
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
   *
   * PYG-540: ซ่อนนัดหมายของผู้รับบริการที่ "ถอนความยินยอมเปิดเผยให้กลุ่มครอบครัว"
   *   ยกเว้นคนที่เกี่ยวข้องโดยตรงยังเห็นเหมือนเดิม:
   *   - เจ้าของข้อมูลเอง (ข้อมูลของเขา)
   *   - คนกดจอง (เป็นคู่สัญญา/คนจ่ายเงิน — เห็นใบนี้ในประวัติการจองของตัวเองอยู่แล้ว
   *     ซ่อนจากหน้ากลุ่มไปก็ไม่ได้ปกป้องอะไรเพิ่ม มีแต่ทำให้งงว่านัดหายไปไหน)
   *   ไม่ลบนัดหมาย — แค่ไม่แสดงให้สมาชิกคนอื่น ถ้าให้ความยินยอมกลับ นัดก็กลับมาแสดง
   */
  async groupBookings(
    groupId: string,
    viewerUserId: string,
  ): Promise<GroupBookingSummary[]> {
    const rows = await this.prisma.booking.findMany({
      where: { familyGroupId: groupId },
      include: {
        caregiver: { include: { user: { select: { avatarUrl: true } } } },
        // PYG-540: patientId ของโปรไฟล์ = เจ้าของข้อมูล ใช้ตรวจความยินยอม
        careRecipient: { select: { name: true, patientId: true } },
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

    // PYG-540: เจ้าของข้อมูลของแต่ละใบ — ไม่มีโปรไฟล์ (ไม่ควรเกิดกับการจองแทน) ถือว่าคนจองเป็นเจ้าของ
    const subjectOf = (b: (typeof rows)[number]) => b.careRecipient?.patientId ?? b.patientId;
    // query เดียวต่อหน้า ไม่ใช่ใบละ query
    const withdrawn = await this.consentService.withdrawnUserIds(
      rows.map(subjectOf),
      CONSENT_TYPE.DISCLOSE_TO_FAMILY_GROUP,
    );
    const items = rows.filter((b) => {
      const subject = subjectOf(b);
      return (
        !withdrawn.has(subject) ||
        subject === viewerUserId ||
        b.bookedBy === viewerUserId
      );
    });

    // PYG-518: เซ็น avatar ของผู้ดูแลทุกใบในฟีดกลุ่มพร้อมกัน (createSignedUrls ครั้งเดียว)
    await this.signCaregiverAvatars(items);

    return items.map((b) => ({
      id: b.id,
      bookingDate:
        b.bookingDate instanceof Date
          ? b.bookingDate.toISOString().slice(0, 10)
          : String(b.bookingDate),
      startTime: formatStartTime(b.startTime),
      // PYG-526: การ์ดนัดหมายของกลุ่มแสดง "เริ่ม – สิ้นสุด (N ชม.)"
      endTime: computeEndTime(b.startTime, b.durationHours),
      status: b.status,
      serviceType: b.serviceType,
      durationHours: b.durationHours != null ? Number(b.durationHours) : undefined,
      careRecipientName: b.careRecipient?.name ?? undefined,
      caregiver: b.caregiver
        ? {
            id: b.caregiver.id,
            fullName: b.caregiver.fullName ?? undefined,
            avatarUrl: b.caregiver.user.avatarUrl ?? undefined,
            // ราคาของใบจองนี้ (estimated_cost ÷ ชม.) ไม่ใช่ hourly_rate ปัจจุบันของผู้ดูแล
            hourlyRate: bookingHourlyRate(b.estimatedCost, b.durationHours),
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

  /**
   * PYG-518 — เซ็น avatarUrl ของผู้ดูแลในหลาย booking row พร้อมกัน (createSignedUrls
   * ครั้งเดียว ไม่ยิงทีละแถว) แล้ว mutate ค่าใน row.caregiver.user.avatarUrl ให้เป็น
   * signed URL ตรง ๆ — เรียกก่อน toSummary/toRestSummary/groupBookings เสมอ
   * เพื่อให้ตัว mapper ที่เหลือไม่ต้องรู้เรื่อง signing เลย แค่อ่านค่าที่มีอยู่ตามปกติ
   */
  private async signCaregiverAvatars(
    rows: ReadonlyArray<{ caregiver: { user: { avatarUrl: string | null } } | null }>,
  ): Promise<void> {
    const withCaregiver = rows.filter(
      (r): r is { caregiver: { user: { avatarUrl: string | null } } } => !!r.caregiver,
    );
    if (withCaregiver.length === 0) return;

    const urlByRow = await this.avatarUrlService.resolveMany(
      withCaregiver,
      (r) => r.caregiver.user.avatarUrl,
    );
    for (const r of withCaregiver) {
      r.caregiver.user.avatarUrl = urlByRow.get(r) ?? null;
    }
  }

  /** REST summary (caregiver may be null for unmatched bookings) */
  private async toRestSummary(booking: BookingWithIncludes): Promise<BookingRest> {
    const saved = await readSavedRequiredSkills(this.prisma, [booking.id]);
    if (!saved.has(booking.id)) throw new NotFoundException('Booking not found');
    const caregiver: CaregiverBriefRest | undefined = booking.caregiver
      ? {
          id:         booking.caregiver.id,
          fullName:   booking.caregiver.fullName   ?? undefined,
          avatarUrl:  booking.caregiver.user.avatarUrl ?? undefined,
          // ราคาของใบจองนี้ (estimated_cost ÷ ชม.) ไม่ใช่ hourly_rate ปัจจุบันของผู้ดูแล
          hourlyRate: bookingHourlyRate(booking.estimatedCost, booking.durationHours),
        }
      : undefined;

    return {
      id:               booking.id,
      requiredSkills:   saved.get(booking.id)!,
      bookingDate:      booking.bookingDate instanceof Date
                          ? booking.bookingDate.toISOString().slice(0, 10)
                          : String(booking.bookingDate),
      status:           booking.status,
      serviceType:      booking.serviceType,
      timeSlot:         booking.timeSlot,
      // PYG-526: ให้ REST มีเวลาจริงเหมือน GraphQL — endTime คำนวณจาก startTime + durationHours
      startTime:        formatStartTime(booking.startTime),
      endTime:          computeEndTime(booking.startTime, booking.durationHours),
      // Number(): คอลัมน์เป็น Decimal — ถ้าส่งตรง ๆ JSON จะออกมาเป็น string "4"
      durationHours:    booking.durationHours != null ? Number(booking.durationHours) : undefined,
      tasks:            booking.tasks,
      serviceLocations: booking.serviceLocations,
      locationAddress:  booking.locationAddress,
      notes:            booking.notes ?? undefined,
      estimatedCost:    booking.estimatedCost != null
                          ? booking.estimatedCost.toNumber()
                          : undefined,
      caregiver,
      // PYG-634: กิจกรรมจากสำเนา ณ ตอนจอง (ไม่อ่านค่าปัจจุบันของ care_activities)
      activities:       toBookingActivities(booking.activities),
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
          // ราคาของใบจองนี้ (estimated_cost ÷ ชม.) ไม่ใช่ hourly_rate ปัจจุบันของผู้ดูแล
          hourlyRate: bookingHourlyRate(booking.estimatedCost, booking.durationHours),
          averageRating:   booking.caregiver.averageRating   ?? undefined,
          reviewCount:     booking.caregiver.reviewCount     ?? undefined,
          experienceYears: booking.caregiver.experienceYears ?? undefined,
          phone: CAREGIVER_PHONE_VISIBLE_STATUSES.has(booking.status)
            ? booking.caregiver.phone ?? undefined
            : undefined,
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
      startTime:        formatStartTime(booking.startTime),
      // PYG-526: FE แสดง "เริ่ม – สิ้นสุด (N ชม.)" แทนชื่อ slot — คำนวณที่ BE ที่เดียว
      endTime:          computeEndTime(booking.startTime, booking.durationHours),
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
      patientName:              booking.patientName              ?? undefined,
      dayOfContactName:         booking.dayOfContactName         ?? undefined,
      dayOfContactPhone:        booking.dayOfContactPhone        ?? undefined,
      dayOfContactRelationship: booking.dayOfContactRelationship ?? undefined,
      // JSONB → ส่งต่อตามรูปทรงที่เก็บไว้ (เหมือน CaregiverBookingService.toSummary)
      patientProfile: (booking.memberDetails as PatientProfileType | null) ?? undefined,
      confirmedAt:      booking.confirmedAt   ?? undefined,
      disputeStatus:    booking.disputeStatus ?? 'none',
      disputeReason:    booking.disputeReason ?? undefined,
      // PYG-352: พิกัดจุดงาน — FE ใช้ปักหมุด "จุดงาน" และวาดวงรัศมีสองวงบนแผนที่
      locationLat:      booking.locationLat != null ? booking.locationLat.toNumber() : undefined,
      locationLng:      booking.locationLng != null ? booking.locationLng.toNumber() : undefined,
      createdAt:        booking.createdAt,
    };
  }

  private async toListResponse(
    items: BookingWithIncludes[],
    { page, limit, total }: { page: number; limit: number; total: number },
  ): Promise<BookingListResponse> {
    await this.signCaregiverAvatars(items);
    const pagination: BookingPagination = {
      page,
      limit,
      total,
      totalPages: total === 0 ? 1 : Math.ceil(total / limit),
    };
    return { data: items.map((b) => this.toSummary(b)), pagination };
  }
}
