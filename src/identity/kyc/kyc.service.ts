/**
 * KycService — Business logic สำหรับ KYC (Know Your Customer)
 *
 * Methods:
 * - submitKyc()        — caregiver ส่ง KYC ครั้งแรก หรือ resubmit หลังถูก reject
 *                        (ตรวจจับอัตโนมัติว่าเป็น first/resubmit จาก existing.kycStatus)
 * - onKycVerified()    — internal trigger สำหรับ admin verify KYC (Sprint 3 endpoint จะเรียก)
 * - onKycRejected()    — internal trigger สำหรับ admin reject KYC (พร้อม reason)
 *
 * PYG-97: หลัง submit/verify/reject สำเร็จ → trigger notification + email
 *   Errors จาก notification/email ไม่ทำให้ KYC operation ล้มเหลว — แค่ log
 *   เหตุผล: business action สำเร็จแล้ว, side-effect (แจ้งเตือน) ไม่ควรย้อนกลับ
 */
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../../common/prisma.service';
import { runInBackground } from '../../common/background-task';
import { KycInput } from './dto/kyc.input';
import { KycStatusPayload } from './dto/kyc-status.payload';
import { PayoutAccountInput } from './dto/payout-account.input';
import { PayoutAccountSummary } from './entities/payout-account.entity';
import { Caregiver } from './entities/caregiver.entity';
import { AuthUser } from '../../common/decorators/current-user.decorator';
import { CaregiverService } from './caregiver.service';
import { NotificationService } from '../../notification/notification.service';
import { EmailService } from '../../email/email.service';
import { NotificationType } from '../../notification/entities/notification-type.enum';
import { Prisma } from '@prisma/client';
import { computeFieldChanges } from './utils/compute-field-changes';
import { PROFILE_PHOTO_DOC_TYPE } from './profile-photo.constants';
import { ClockService } from '../../common/clock.service';
import {
  LICENSE_DOC_TYPE,
  LICENSE_REQUIRED_PROFESSIONS,
  LICENSE_STATUS,
} from './license/license.constants';
import { LICENSE_ERROR, LicenseError, LicenseErrorCode } from './license/license.errors';
import { isBangkokDateInFuture } from './license/license-date';
import { DrivingLicenseService } from './driving-license/driving-license.service';
import { TransportMode, resolveTransport, toTransportMode } from './driving-license/transport-mode';
import { buildDrivingLicenseInfo } from './driving-license/driving-license-info.entity';
import { pickLatestLicense } from './license/license-info.entity';
import { normalizeLicenseNumber } from './license/license-validation';
import { parseProfessionInput } from './profession.errors';
import { PayoutEncryptionService } from '../../common/crypto/payout-encryption.service';
import { PayoutAccountService } from '../../payment/payout-account.service';
import { evaluatePayoutReadiness } from '../../payment/payout-account-readiness';
import {
  normalizeAccountNumber,
  validateAccountNumberForBank,
} from '../../common/constants/omise-banks.constant';
import { CareSkillService } from '../../care-skill/care-skill.service';

/**
 * Fields ที่ต้องการ track เมื่อ caregiver submit/resubmit KYC
 * ไม่มี hourlyRate (PYG-536) — submitKyc ไม่เขียนค่านี้แล้ว จึงไม่ต้อง diff
 * PYG-575: เพิ่ม profession — resubmit ที่เปลี่ยนวิชาชีพ (E2) มีประวัติ old → new ใน caregiver_edit_logs
 */
const KYC_TRACKED_FIELDS = [
  'fullName', 'idCardNumber', 'gender', 'dateOfBirth',
  'phone', 'skills', 'otherSkills',
  'experienceYears', 'bio', 'profession',
];

/**
 * PYG-266: fields ของบัญชีรับเงินที่ track ใน caregiver_edit_logs
 * ห้ามเพิ่ม 'accountNumber' ที่นี่เด็ดขาด — เลขบัญชีต้องไม่ปรากฏใน log แม้แต่ diff
 */
const PAYOUT_TRACKED_FIELDS = ['bankCode', 'accountName'];

/** สถานะที่อนุญาตให้ยื่น KYC ได้ (first time หรือ resubmit) */
const SUBMITTABLE_STATUSES = new Set(['none', 'rejected']);

@Injectable()
export class KycService {
  private readonly logger = new Logger(KycService.name);

  constructor(
    private prismaService: PrismaService,
    private caregiverService: CaregiverService,
    private notificationService: NotificationService,
    private emailService: EmailService,
    private payoutEncryption: PayoutEncryptionService,
    private payoutAccountService: PayoutAccountService,
    private careSkillService: CareSkillService,
    private clock: ClockService,
    private drivingLicense: DrivingLicenseService,
  ) {}

  /**
   * submitKyc — สร้างหรืออัปเดต caregiver record + link เอกสาร KYC
   *
   * Detect first-submit vs resubmit จาก existing.kycStatus:
   * - 'none' (or no record)  → first submit  → trigger kyc_submitted
   * - 'rejected'             → resubmit      → trigger kyc_resubmitted
   * - 'pending' / 'verified' → throw ConflictException
   *
   * @param user  - user ที่ login อยู่ (inject โดย SupabaseAuthGuard)
   * @param input - ข้อมูล KYC ที่ client ส่งมา
   * @returns Caregiver entity ที่ถูกสร้าง/อัปเดต
   */
  async submitKyc(user: AuthUser, input: KycInput): Promise<Caregiver> {
    // ── ขั้นตอนที่ 0: ตรวจวิชาชีพ (PYG-575) — ก่อนแตะ DB ────────────────
    // ไม่ส่ง → PROFESSION_REQUIRED (client เก่า · ไม่เติมค่าเริ่มต้นให้ · S01-E3)
    // ค่านอกรายการ → PROFESSION_INVALID (S01-E4 · DB มี CHECK กันอีกชั้น)
    // ตรวจก่อนสถานะ KYC โดยตั้งใจ: client เก่าเห็น code เดียวกันเสมอไม่ว่าสถานะใด
    const profession = parseProfessionInput(input.profession);

    // ── ขั้นตอนที่ 1: เช็ค KYC status ปัจจุบัน ────────────────────────
    const existing = await this.prismaService.caregiver.findUnique({
      where: { userId: user.id },
    });

    const currentStatus = existing?.kycStatus ?? 'none';
    if (!SUBMITTABLE_STATUSES.has(currentStatus)) {
      throw new ConflictException(
        `KYC already submitted. Current status: "${currentStatus}"`,
      );
    }

    const isResubmit = currentStatus === 'rejected';

    // ── PYG-652: ทักษะต้องเป็นรหัสกลางที่วิชาชีพของผู้ดูแลถือได้ ────────────
    // ★ ใช้วิชาชีพที่ส่งมาในรอบนี้ (PYG-575) ไม่ใช่ค่าเดิมในแถว — ค่านี้คือค่าที่จะถูกเขียนลงตาราง
    //   ถ้าอ่านจากแถวเดิม ผู้สมัครใหม่ (ยังไม่มีแถว) ที่เป็น nurse จะเลือกทักษะเฉพาะพยาบาลไม่ได้
    //   และคนที่ยื่นซ้ำแล้วเปลี่ยนจาก nurse เป็น general_caregiver จะเก็บทักษะเฉพาะพยาบาลไว้ได้
    await this.careSkillService.assertSkillsAllowed(input.skills, profession);

    // ── ขั้นตอนที่ 2: Validate documentIds ───────────────────────────
    if (input.documentIds.length > 0) {
      const foundDocs = await this.prismaService.kycDocument.findMany({
        where: {
          id: { in: input.documentIds },
          userId: user.id,
        },
        select: { id: true },
      });

      const foundIds = foundDocs.map((d) => d.id);
      const missingIds = input.documentIds.filter(
        (id) => !foundIds.includes(id),
      );

      if (missingIds.length > 0) {
        throw new NotFoundException(
          `Document IDs not found or not owned by user: ${missingIds.join(', ')}`,
        );
      }
    }

    // ── ขั้นตอนที่ 2.5: ใบประกอบวิชาชีพ (PYG-587) ────────────────────
    // ตรวจที่ชั้น service ก่อนเขียนอะไรลง DB · general_caregiver ไม่ตรวจ (E9: ถ้าแนบมาก็ไม่ถูกบังคับ/ไม่ถูกปฏิเสธ)
    // ★ ใช้วิชาชีพที่ส่งมาในรอบนี้ (PYG-575) ไม่ใช่ค่าเดิมในแถว — ค่านี้คือค่าที่จะถูกเขียนลงตารางข้างล่าง
    //   ถ้าอ่านจากแถวเดิม ผู้ดูแลใหม่ (ยังไม่มีแถว = general_caregiver) หรือคนที่ยื่นซ้ำแล้วเปลี่ยนเป็น nurse
    //   จะข้ามการตรวจใบประกอบฯ ได้
    await this.assertLicenseForKyc(
      user.id,
      profession,
      input.documentIds,
      existing ? { id: existing.id, profession: existing.profession } : null,
    );

    // PYG-597: ขับรถรับส่งเอง -> ต้องมีใบขับขี่ที่ใช้ได้ในรอบส่งนี้ (ตรวจที่ service ก่อนเขียนอะไรลง DB)
    //   PYG-661: transportMode (ใหม่) หรือ selfDriveTransport (เดิม) → ค่าเดียว · ขัดกัน = 422
    const transport = resolveTransport(input);
    await this.drivingLicense.assertForKyc(user.id, transport.selfDrive, input.documentIds);

    // ── ขั้นตอนที่ 3: Upsert caregiver + link documents (atomic) ─────
    const caregiver = await this.prismaService.$transaction(async (tx) => {
      // Generate caregiverNumber เฉพาะ record ใหม่ (format: CG-YYMMDD-XXXX)
      let caregiverNumber = existing?.caregiverNumber;
      if (!caregiverNumber) {
        caregiverNumber = await this.caregiverService.generateCaregiverNumber(
          tx,
        );
      }

      const upserted = await tx.caregiver.upsert({
        where: { userId: user.id },
        create: {
          userId: user.id,
          caregiverNumber,
          fullName: input.fullName,
          idCardNumber: input.idCardNumber,
          gender: input.gender,
          dateOfBirth: input.dateOfBirth,
          phone: input.phone,
          skills: input.skills,
          otherSkills: input.otherSkills ?? [],
          profession, // PYG-575
          ...(transport.write && { transportMode: transport.write }), // PYG-661
          experienceYears: input.experienceYears,
          // ไม่เขียน hourlyRate (PYG-536) — ผู้ดูแลตั้งราคาเองไม่ได้ ราคามาจาก service_price_catalog
          bio: input.bio,
          kycStatus: 'pending',
          kycSubmittedAt: new Date(),
          isSearchable: false,
        },
        update: {
          fullName: input.fullName,
          idCardNumber: input.idCardNumber,
          gender: input.gender,
          dateOfBirth: input.dateOfBirth,
          phone: input.phone,
          skills: input.skills,
          // ไม่ส่งมา = คงค่าเดิม (FE รุ่นที่ยังไม่มีช่องทักษะอื่น ๆ จะได้ไม่ลบของเดิมทิ้ง)
          ...(input.otherSkills !== undefined && {
            otherSkills: input.otherSkills,
          }),
          // PYG-575 · E2: ถูกปฏิเสธแล้วส่งใหม่ เปลี่ยนวิชาชีพได้ทันที (ยังไม่เคยอนุมัติ — แอดมินตรวจทั้งชุดอยู่แล้ว)
          profession,
          // PYG-661: ไม่ส่ง/false = คงค่าเดิม (NULL ยังเป็น NULL) ไม่ตีความเป็น none (E10)
          ...(transport.write && { transportMode: transport.write }),
          experienceYears: input.experienceYears,
          // ไม่เขียน hourlyRate (PYG-536) — ผู้ดูแลตั้งราคาเองไม่ได้ ราคามาจาก service_price_catalog
          bio: input.bio,
          kycStatus: 'pending',
          kycSubmittedAt: new Date(),
          kycVerifiedAt: null,
          rejection_reasons: Prisma.DbNull,
          resubmitCount: isResubmit ? (existing?.resubmitCount ?? 0) + 1 : 0,
        },
      });

      // Query old linked docs (id + type) BEFORE unlinking (for audit diff)
      // PYG-508: รูปโปรไฟล์ไม่ใช่เอกสารของรอบ KYC — ห้ามปลด caregiverId ทิ้งตอน resubmit
      //   ไม่งั้นรูปที่รออนุมัติหลุดจากคิวแอดมิน และรูปที่อนุมัติแล้วหาเจ้าของไม่เจอ
      const kycDocsOfCaregiver = {
        caregiverId: upserted.id,
        documentType: { not: PROFILE_PHOTO_DOC_TYPE },
      };

      const oldLinkedDocs = isResubmit
        ? await tx.kycDocument.findMany({
            where: kycDocsOfCaregiver,
            select: { id: true, documentType: true },
          })
        : [];

      // On resubmit: unlink all old documents before linking new ones
      // so queries on caregiverId only return the current submission's docs
      if (isResubmit) {
        await tx.kycDocument.updateMany({
          where: kycDocsOfCaregiver,
          data: { caregiverId: null },
        });
      }

      // Query new doc ids + types from submitted documentIds (for audit diff)
      const newSubmittedDocs = input.documentIds.length > 0
        ? await tx.kycDocument.findMany({
            where: { id: { in: input.documentIds }, userId: user.id },
            select: { id: true, documentType: true },
          })
        : [];

      if (input.documentIds.length > 0) {
        await tx.kycDocument.updateMany({
          where: {
            id: { in: input.documentIds },
            userId: user.id,
          },
          data: { caregiverId: upserted.id },
        });
      }

      // ── บันทึก edit log (caregiver_edit_logs) ────────────────────
      // ใช้ $executeRaw เพราะ Prisma client ยังไม่ regenerate
      const fieldChanges = existing
        ? computeFieldChanges(
            existing as unknown as Record<string, unknown>,
            // ใส่ profession ที่ตรวจแล้ว (ค่าเดียวกับที่เขียนลงตาราง) — log ต้องตรงกับสิ่งที่บันทึกจริง
            { ...input, profession } as unknown as Record<string, unknown>,
            KYC_TRACKED_FIELDS,
          )
        : [];

      // Compute document diff by ID:
      // ถ้า document ID ใหม่ไม่มีใน old linked docs → ถือว่ามีการ upload/เปลี่ยน
      // (ครอบคลุม re-upload same type เพราะจะได้ ID ใหม่เสมอ)
      const oldDocIds = new Set(oldLinkedDocs.map((d) => d.id));
      const docChanges: Array<{ field: string; oldValue: string | null; newValue: string | null }> = [];
      for (const doc of newSubmittedDocs) {
        if (!oldDocIds.has(doc.id)) {
          docChanges.push({ field: 'document', oldValue: null, newValue: doc.documentType });
        }
      }

      // PYG-266: upsert บัญชีรับเงิน — เฉพาะตอนที่ caregiver แนบ payoutAccount มาด้วย
      const payoutChanges = input.payoutAccount
        ? (await this.upsertPayoutAccountInTx(tx, upserted.id, input.payoutAccount)).changes
        : [];

      const allChanges = [...fieldChanges, ...docChanges, ...payoutChanges];
      const action = isResubmit ? 'resubmit' : 'first_submit';

      // resubmit → log เสมอ; first_submit → log ถ้ามี changes
      if (isResubmit || allChanges.length > 0) {
        const changesJson = JSON.stringify(allChanges);
        await tx.$executeRaw`
          INSERT INTO caregiver_edit_logs (id, caregiver_id, edited_by, action, field_changes, created_at)
          VALUES (gen_random_uuid(), ${upserted.id}, ${user.id}, ${action}, ${changesJson}::jsonb, NOW())
        `;
      }

      return upserted;
    });

    // ── ขั้นตอนที่ 4: Trigger notification + email (PYG-97) ──────────
    // ห่อ try-catch รวม — error ใดๆ จาก side-effect ไม่ควรทำให้ submit fail
    if (isResubmit) {
      await this.triggerKycResubmitted(user.id, caregiver.id);
    } else {
      await this.triggerKycSubmitted(user.id, caregiver.id);
    }

    // ── ขั้นตอนที่ 5: Map Prisma → GraphQL entity ───────────────────
    return this.mapToEntity(caregiver);
  }

  /**
   * assertLicenseForKyc — nurse / physiotherapist ต้องมีเอกสารใบประกอบฯ ที่ใช้ได้ในรอบส่งนี้
   * (S03-AC2, E2, E3/E4, E10)
   *
   * "ใช้ได้" = อยู่ใน documentIds ของรอบนี้ + เป็นของผู้ใช้คนนี้ + ไม่ใช่ rejected/expired
   * + มีเลข + มีวันหมดอายุ + วันหมดอายุเป็นอนาคตตามเวลาไทย
   * ใบที่ผ่านการตรวจมาก่อนแต่ไม่ได้ส่งมาในรอบนี้ไม่นับ (E2: เปลี่ยนวิชาชีพต้องมีใบใหม่ที่ส่งมาพร้อมกัน)
   * E2 (PYG-670): ยื่นซ้ำโดยสลับพยาบาล ↔ นักกายภาพฯ — ใบที่ผูกกับรอบก่อน (caregiver_id = แถวเดิม) เป็นของวิชาชีพเดิม
   *   ใช้ไม่ได้แม้ client ส่ง id เดิมกลับมา ต้องเป็นใบที่อัปโหลดใหม่ (ยังไม่ผูก — resubmit ปลด/ผูกทีหลังใน transaction)
   * ขาดหลายช่อง → ตอบครบในครั้งเดียว (extensions.codes) · code = ช่องแรก (FILE → NUMBER → EXPIRY)
   *
   * @param previous แถวผู้ดูแลเดิม (ยื่นซ้ำ) — ไม่มี = ผู้สมัครใหม่
   */
  private async assertLicenseForKyc(
    userId: string,
    profession: string,
    documentIds: string[],
    previous: { id: string; profession: string } | null = null,
  ): Promise<void> {
    if (!LICENSE_REQUIRED_PROFESSIONS.has(profession)) return;

    const switchedLicensedProfession =
      previous !== null &&
      previous.profession !== profession &&
      LICENSE_REQUIRED_PROFESSIONS.has(previous.profession);

    const licenseDocs =
      documentIds.length > 0
        ? await this.prismaService.kycDocument.findMany({
            where: { id: { in: documentIds }, userId, documentType: LICENSE_DOC_TYPE },
            select: {
              id: true,
              caregiverId: true,
              licenseNumber: true,
              expiresAt: true,
              reviewStatus: true,
              uploadedAt: true,
            },
            orderBy: { uploadedAt: 'desc' },
          })
        : [];

    // ใบที่ถูกปฏิเสธ/หมดอายุแล้วใช้ส่งซ้ำไม่ได้ — ต้องอัปโหลดใบใหม่ (E6)
    const usable = licenseDocs.find(
      (d) =>
        d.reviewStatus !== LICENSE_STATUS.REJECTED &&
        d.reviewStatus !== LICENSE_STATUS.EXPIRED &&
        !(switchedLicensedProfession && d.caregiverId === previous.id),
    );

    if (!usable) throw new LicenseError(LICENSE_ERROR.FILE_REQUIRED);

    const errors: LicenseErrorCode[] = [];
    if (!normalizeLicenseNumber(usable.licenseNumber)) errors.push(LICENSE_ERROR.NUMBER_REQUIRED);
    if (!usable.expiresAt) errors.push(LICENSE_ERROR.EXPIRY_REQUIRED);
    else if (!isBangkokDateInFuture(usable.expiresAt, this.clock.now())) {
      errors.push(LICENSE_ERROR.EXPIRY_NOT_FUTURE);
    }
    if (errors.length > 0) throw new LicenseError(errors[0], errors);
  }

  /**
   * resubmitKyc — ยื่น KYC ใหม่หลังถูก reject
   */
  async resubmitKyc(user: AuthUser, input: KycInput): Promise<Caregiver> {
    return this.submitKyc(user, input);
  }

  /**
   * updatePayoutAccount — PYG-266: caregiver ที่ verified แล้วเพิ่ม/แก้บัญชีรับเงินเอง
   *
   * นอก flow submitKyc/resubmitKyc ที่ถูกบล็อกไว้เมื่อ kycStatus='verified'
   * (SUBMITTABLE_STATUSES = none/rejected เท่านั้น) — caregiver ที่ผ่านการยืนยันแล้ว
   * (รวมถึงคนที่ verified ก่อนฟีเจอร์นี้จะมีอยู่) ใช้ mutation นี้แทน
   */
  async updatePayoutAccount(
    user: AuthUser,
    input: PayoutAccountInput,
  ): Promise<PayoutAccountSummary> {
    const caregiver = await this.prismaService.caregiver.findUnique({
      where: { userId: user.id },
    });

    if (!caregiver) {
      throw new NotFoundException('ไม่พบข้อมูล caregiver ของคุณ');
    }

    if (caregiver.kycStatus !== 'verified') {
      throw new BadRequestException(
        'ต้องผ่านการยืนยันตัวตน (KYC) ก่อนจึงจะแก้ไขบัญชีรับเงินได้ — กรุณาส่งหรือแก้ไข KYC ผ่านหน้ายืนยันตัวตนแทน',
      );
    }

    const { account } = await this.prismaService.$transaction(async (tx) => {
      const result = await this.upsertPayoutAccountInTx(tx, caregiver.id, input);

      if (result.changes.length > 0) {
        const changesJson = JSON.stringify(result.changes);
        await tx.$executeRaw`
          INSERT INTO caregiver_edit_logs (id, caregiver_id, edited_by, action, field_changes, created_at)
          VALUES (gen_random_uuid(), ${caregiver.id}, ${user.id}, 'payout_account_update', ${changesJson}::jsonb, NOW())
        `;
      }

      return result;
    });

    // Fire-and-forget: สร้าง Omise recipient ใหม่เสมอ (upsertPayoutAccountInTx reset
    // omiseRecipientId เป็น null ทุกครั้งที่แตะบัญชีนี้ — no-op ถ้าดันมี id อยู่แล้ว)
    runInBackground(
      this.payoutAccountService.createRecipientForCaregiver(
        caregiver.id,
        caregiver.fullName ?? '',
        user.email,
      ),
    );

    return this.mapPayoutAccountSummary(account);
  }

  /**
   * updateTransportMode — PYG-661 (E1/E2): ผู้ดูแลที่ KYC ผ่านแล้วเปลี่ยนวิธีเดินทางเอง
   *
   * ไม่บังคับแนบใบขับขี่ตอนนี้ — ป้ายฝั่ง Elder และประตูรับงาน (AC5) อ่านผลตรวจใบอยู่แล้ว
   * (เปลี่ยนเป็น SELF_DRIVE แต่ยังไม่มีใบที่ผ่านก็ไม่ได้ป้าย และรับงานรับส่งไม่ได้)
   * ไม่เปลี่ยน kycStatus (E1 รอเคาะจาก story)
   */
  async updateTransportMode(userId: string, mode: TransportMode): Promise<TransportMode> {
    const caregiver = await this.prismaService.caregiver.findUnique({
      where: { userId },
      select: { id: true, kycStatus: true },
    });
    if (!caregiver) throw new NotFoundException('ไม่พบข้อมูล caregiver ของคุณ');
    if (caregiver.kycStatus !== 'verified') {
      throw new ForbiddenException('ต้องผ่านการยืนยันตัวตนก่อน — ระบุวิธีเดินทางผ่านการส่ง KYC');
    }

    await this.prismaService.caregiver.update({
      where: { id: caregiver.id },
      data: { transportMode: mode },
    });
    this.logger.log({ event: 'caregiver.transport_mode.updated', caregiverId: caregiver.id });
    return mode;
  }

  /**
   * getKycStatus — ดึงข้อมูล KYC status ครบชุดสำหรับ Status Page
   */
  async getKycStatus(userId: string): Promise<KycStatusPayload> {
    const caregiver = await this.prismaService.caregiver.findUnique({
      where: { userId },
    });

    if (!caregiver) {
      return {
        status: 'none',
        documents: [],
        drivingLicense: { verified: false, status: 'none', isExpired: false },
        canAcceptJobs: false,
      };
    }

    const documents = await this.caregiverService.getOwnDocumentsWithSignedUrls(
      caregiver.id,
    );

    const payoutAccountRow = await this.prismaService.caregiverPayoutAccount.findUnique({
      where: { caregiverId: caregiver.id },
    });

    const readiness = evaluatePayoutReadiness(payoutAccountRow);
    const kycVerified = caregiver.kycStatus === 'verified';

    return {
      status: caregiver.kycStatus,
      submittedAt: caregiver.kycSubmittedAt ?? undefined,
      verifiedAt: caregiver.kycVerifiedAt ?? undefined,
      caregiver: this.mapToEntity(caregiver),
      documents,
      profession: caregiver.profession,
      transportMode: toTransportMode(caregiver.transportMode),
      license: pickLatestLicense(documents, this.clock.now()),
      drivingLicense: buildDrivingLicenseInfo(
        await this.drivingLicense.getState({ caregiverId: caregiver.id, userId }),
        documents,
      ),
      payoutAccount: payoutAccountRow
        ? this.mapPayoutAccountSummary(payoutAccountRow)
        : undefined,
      canAcceptJobs: kycVerified && readiness.ready,
      payoutBlockReason: kycVerified ? readiness.reason : undefined,
    };
  }

  /**
   * deleteKycDocument — ลบเอกสาร KYC
   */
  async deleteKycDocument(documentId: string, userId: string): Promise<boolean> {
    const doc = await this.prismaService.kycDocument.findUnique({
      where: { id: documentId },
    });

    if (!doc) {
      throw new NotFoundException(`Document with ID "${documentId}" not found`);
    }

    if (doc.userId !== userId) {
      throw new ForbiddenException('คุณไม่มีสิทธิ์ลบเอกสารนี้');
    }

    const caregiver = await this.prismaService.caregiver.findUnique({
      where: { userId },
    });

    if (caregiver && (caregiver.kycStatus === 'pending' || caregiver.kycStatus === 'verified')) {
      throw new ConflictException(
        'ไม่สามารถลบเอกสารได้ขณะที่อยู่ระหว่างการตรวจสอบหรือผ่านการยืนยันแล้ว',
      );
    }

    await this.prismaService.kycDocument.delete({
      where: { id: documentId },
    });

    return true;
  }

  /**
   * onKycVerified — เรียกจาก admin endpoint เมื่อ approve KYC
   */
  async onKycVerified(caregiverId: string): Promise<Caregiver> {
    // updateStatus จะ throw ถ้าไม่พบ caregiver + set kycVerifiedAt อัตโนมัติ
    const caregiver = await this.caregiverService.updateStatus(
      caregiverId,
      'verified',
    );

    await this.triggerKycVerified(caregiver.userId, caregiver.id);

    return caregiver;
  }

  /**
   * onKycRejected — เรียกจาก admin endpoint (Sprint 3) ตอน reject KYC (PYG-97)
   *
   * Side-effects:
   * - update caregiver.kycStatus = 'rejected'
   * - trigger notification (kyc_rejected) + email พร้อม reason
   *
   * NOTE: ยังไม่ persist reason ลง DB — admin endpoint (Sprint 3) จะสร้าง KycReview row
   *       เพื่อเก็บประวัติ review พร้อม reason เป็น audit trail
   *
   * @param caregiverId - UUID ของ caregiver ที่จะ reject
   * @param reason      - เหตุผลที่ admin ใส่ (ส่งให้ caregiver ทาง notification + email)
   */
  async onKycRejected(caregiverId: string, reason: string): Promise<Caregiver> {
    const caregiver = await this.caregiverService.updateStatus(
      caregiverId,
      'rejected',
    );

    await this.triggerKycRejected(caregiver.userId, caregiver.id, reason);

    return caregiver;
  }

  // ─── Private helpers — trigger notification + email ──────────────────

  private async triggerKycSubmitted(userId: string, caregiverId: string): Promise<void> {
    try {
      await this.notificationService.create(
        userId,
        NotificationType.kyc_submitted,
        'ส่งเอกสารยืนยันตัวตนสำเร็จ',
        'ทีมงานจะตรวจสอบภายใน 1-2 วันทำการ',
        { caregiverId, linkPath: '/kyc' },
      );
    } catch (err) {
      this.logCaught('notification kyc_submitted', userId, err);
    }

    try {
      await this.emailService.sendKycSubmitted(userId);
    } catch (err) {
      // EmailService สวอลโลว์ error เองอยู่แล้ว — แต่กันไว้เผื่อ throw จาก fetchUser
      this.logCaught('email kyc_submitted', userId, err);
    }
  }

  /** Resubmit หลังถูก reject → kyc_resubmitted event */
  private async triggerKycResubmitted(
    userId: string,
    caregiverId: string,
  ): Promise<void> {
    try {
      await this.notificationService.create(
        userId,
        NotificationType.kyc_resubmitted,
        'รับเอกสารใหม่เรียบร้อย',
        'ทีมงานจะตรวจสอบอีกครั้งภายใน 1-2 วันทำการ',
        { caregiverId, linkPath: '/kyc' },
      );
    } catch (err) {
      this.logCaught('notification kyc_resubmitted', userId, err);
    }

    try {
      await this.emailService.sendKycResubmitted(userId);
    } catch (err) {
      this.logCaught('email kyc_resubmitted', userId, err);
    }
  }

  /** Admin approve → kyc_verified event */
  private async triggerKycVerified(
    userId: string,
    caregiverId: string,
  ): Promise<void> {
    try {
      await this.notificationService.create(
        userId,
        NotificationType.kyc_verified,
        'ยืนยันตัวตนสำเร็จ 🎉',
        'คุณสามารถเริ่มรับงานได้แล้ว',
        { caregiverId, linkPath: '/dashboard' },
      );
    } catch (err) {
      this.logCaught('notification kyc_verified', userId, err);
    }

    try {
      await this.emailService.sendKycVerified(userId);
    } catch (err) {
      this.logCaught('email kyc_verified', userId, err);
    }
  }

  private async triggerKycRejected(userId: string, caregiverId: string, reason: string): Promise<void> {
    try {
      await this.notificationService.create(
        userId,
        NotificationType.kyc_rejected,
        'การยืนยันตัวตนไม่ผ่าน',
        `เหตุผล: ${reason}`,
        { caregiverId, linkPath: '/kyc/resubmit' },
      );
    } catch (err) {
      this.logCaught('notification kyc_rejected', userId, err);
    }

    try {
      await this.emailService.sendKycRejected(userId, reason);
    } catch (err) {
      this.logCaught('email kyc_rejected', userId, err);
    }
  }

  private logCaught(action: string, userId: string, error: any) {
    this.logger.error(
      `Failed to trigger ${action} for user ${userId}: ${error.message}`,
      error.stack,
    );
  }

  /**
   * upsertPayoutAccountInTx — PYG-266: encrypt + upsert บัญชีรับเงิน (ใช้ร่วมกันโดย
   * submitKyc และ updatePayoutAccount — logic เดียวกันเป๊ะ ไม่อยาก duplicate)
   *
   * DECISION: ไม่เช็คว่า "เปลี่ยนจริงไหม" ด้วยการเทียบ accountNumberLast4 — เลขบัญชี
   * สองเลขที่ต่างกันอาจบังเอิญ (หรือตั้งใจ) ลงท้ายเหมือนกัน ซึ่งจะทำให้พลาด reset
   * omiseRecipientId ทิ้งไว้ชี้ไปบัญชีเก่า จึง reset ทุกครั้งที่แตะ payoutAccount
   * โดยไม่มีเงื่อนไข (ถูกกว่าความเสี่ยงเงินโอนผิดบัญชีมาก)
   */
  private async upsertPayoutAccountInTx(
    tx: Prisma.TransactionClient,
    caregiverId: string,
    input: PayoutAccountInput,
  ): Promise<{
    account: {
      id: string;
      caregiverId: string;
      bankCode: string;
      accountName: string;
      accountNumberEnc: string;
      accountNumberLast4: string;
      omiseRecipientId: string | null;
      recipientStatus: string;
      status: string;
      verifiedAt: Date | null;
    };
    changes: Array<{ field: string; oldValue: string | null; newValue: string | null }>;
  }> {
    const existingPayout = await tx.caregiverPayoutAccount.findUnique({
      where: { caregiverId },
    });

    // ── ชั้นที่สองของการตรวจเลขบัญชี (TASK 4) ────────────────────────────────
    // DTO ตรวจได้แค่ช่วงกว้าง เพราะ class-validator ไม่เห็น bankCode ตอนตรวจ accountNumber
    // ตรงนี้รู้ทั้งคู่แล้ว จึงใช้กฎรายธนาคารได้ — และ normalize ซ้ำเพื่อกันเส้นทางที่
    // เรียก helper นี้ตรง ๆ โดยไม่ผ่าน DTO (submitKyc ผ่าน KycInput ก็มาลงที่นี่)
    const accountNumber = normalizeAccountNumber(input.accountNumber);
    const invalidReason = validateAccountNumberForBank(input.bankCode, accountNumber);
    if (invalidReason) {
      throw new BadRequestException(invalidReason);
    }

    const accountNumberEnc = this.payoutEncryption.encrypt(accountNumber);
    const accountNumberLast4 = this.payoutEncryption.last4(accountNumber);

    const account = await tx.caregiverPayoutAccount.upsert({
      where: { caregiverId },
      create: {
        caregiverId,
        bankCode: input.bankCode,
        accountName: input.accountName,
        accountNumberEnc,
        accountNumberLast4,
        status: 'pending',
        recipientStatus: 'unverified',
      },
      update: {
        bankCode: input.bankCode,
        accountName: input.accountName,
        accountNumberEnc,
        accountNumberLast4,
        status: 'pending',
        recipientStatus: 'unverified',
        omiseRecipientId: null,
        verifiedAt: null,
      },
    });

    // แตะบัญชี = บัญชีกลับไปรอ Omise ตรวจใหม่ → ปิดรับงานจนกว่าจะ accept อีกครั้ง
    // (ไม่งั้นแก้เลขบัญชีแล้วยังโผล่ในผลค้นหาด้วยบัญชีที่ยังไม่ผ่าน)
    await tx.caregiver.updateMany({
      where: { id: caregiverId, isSearchable: true },
      data: { isSearchable: false },
    });

    const fieldChanges = computeFieldChanges(
      (existingPayout ?? {}) as unknown as Record<string, unknown>,
      input as unknown as Record<string, unknown>,
      PAYOUT_TRACKED_FIELDS,
    );

    // เลขบัญชีถูก resupply ทุกครั้งที่แตะ — บันทึกแค่ last4 เท่านั้น ไม่ใช่ค่าจริง/เข้ารหัส
    fieldChanges.push({
      field: 'accountNumber',
      oldValue: existingPayout ? `***${existingPayout.accountNumberLast4}` : null,
      newValue: `***${accountNumberLast4}`,
    });

    return { account, changes: fieldChanges };
  }

  private mapPayoutAccountSummary(account: {
    bankCode: string;
    accountName: string;
    accountNumberLast4: string;
    status: string;
    recipientStatus: string;
  }): PayoutAccountSummary {
    return {
      bankCode: account.bankCode,
      accountName: account.accountName,
      accountNumberLast4: account.accountNumberLast4,
      status: account.status,
      recipientStatus: account.recipientStatus,
    };
  }

  private mapToEntity(caregiver: any): Caregiver {
    return {
      id: caregiver.id,
      userId: caregiver.userId,
      caregiverNumber: caregiver.caregiverNumber ?? undefined,
      fullName: caregiver.fullName ?? '',
      idCardNumber: caregiver.idCardNumber ?? '',
      gender: caregiver.gender ?? undefined,
      dateOfBirth: caregiver.dateOfBirth ?? undefined,
      phone: caregiver.phone ?? '',
      skills: caregiver.skills,
      otherSkills: caregiver.otherSkills ?? [],
      profession: caregiver.profession, // PYG-575 — DB มี CHECK 3 ค่า
      experienceYears: caregiver.experienceYears ?? 0,
      hourlyRate: caregiver.hourlyRate ?? 0,
      bio: caregiver.bio ?? undefined,
      kycStatus: caregiver.kycStatus,
      kycSubmittedAt: caregiver.kycSubmittedAt ?? undefined,
      kycVerifiedAt: caregiver.kycVerifiedAt ?? undefined,
      isSearchable: caregiver.isSearchable,
      languages: caregiver.languages || [],
      resubmitCount: caregiver.resubmitCount ?? 0,
      createdAt: caregiver.createdAt,
      updatedAt: caregiver.updatedAt,
      rejectionReasons: Array.isArray(caregiver.rejection_reasons)
        ? caregiver.rejection_reasons
        : undefined,
    };
  }
}
