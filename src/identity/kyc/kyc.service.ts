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
import { KycInput } from './dto/kyc.input';
import { KycStatusPayload } from './dto/kyc-status.payload';
import { Caregiver } from './entities/caregiver.entity';
import { AuthUser } from '../../common/decorators/current-user.decorator';
import { CaregiverService } from './caregiver.service';
import { NotificationService } from '../../notification/notification.service';
import { EmailService } from '../../email/email.service';
import { NotificationType } from '../../notification/entities/notification-type.enum';
import { Prisma } from '@prisma/client';
import { computeFieldChanges } from './utils/compute-field-changes';

/** Fields ที่ต้องการ track เมื่อ caregiver submit/resubmit KYC */
const KYC_TRACKED_FIELDS = [
  'fullName', 'idCardNumber', 'gender', 'dateOfBirth',
  'phone', 'skills', 'experienceYears', 'hourlyRate', 'bio',
];

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
          experienceYears: input.experienceYears,
          hourlyRate: input.hourlyRate,
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
          experienceYears: input.experienceYears,
          hourlyRate: input.hourlyRate,
          bio: input.bio,
          kycStatus: 'pending',
          kycSubmittedAt: new Date(),
          kycVerifiedAt: null,
          rejection_reasons: Prisma.DbNull,
          resubmitCount: isResubmit ? (existing?.resubmitCount ?? 0) + 1 : 0,
        },
      });

      // Query old linked docs (id + type) BEFORE unlinking (for audit diff)
      const oldLinkedDocs = isResubmit
        ? await tx.kycDocument.findMany({
            where: { caregiverId: upserted.id },
            select: { id: true, documentType: true },
          })
        : [];

      // On resubmit: unlink all old documents before linking new ones
      // so queries on caregiverId only return the current submission's docs
      if (isResubmit) {
        await tx.kycDocument.updateMany({
          where: { caregiverId: upserted.id },
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
            input as unknown as Record<string, unknown>,
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

      const allChanges = [...fieldChanges, ...docChanges];
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
   * resubmitKyc — ยื่น KYC ใหม่หลังถูก reject
   */
  async resubmitKyc(user: AuthUser, input: KycInput): Promise<Caregiver> {
    return this.submitKyc(user, input);
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
      };
    }

    const documents = await this.caregiverService.getDocumentsWithSignedUrls(
      caregiver.id,
    );

    return {
      status: caregiver.kycStatus,
      submittedAt: caregiver.kycSubmittedAt ?? undefined,
      verifiedAt: caregiver.kycVerifiedAt ?? undefined,
      caregiver: this.mapToEntity(caregiver),
      documents,
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
      experienceYears: caregiver.experienceYears ?? 0,
      hourlyRate: caregiver.hourlyRate ?? 0,
      bio: caregiver.bio ?? undefined,
      kycStatus: caregiver.kycStatus,
      kycSubmittedAt: caregiver.kycSubmittedAt ?? undefined,
      kycVerifiedAt: caregiver.kycVerifiedAt ?? undefined,
      isSearchable: caregiver.isSearchable,
      resubmitCount: caregiver.resubmitCount ?? 0,
      createdAt: caregiver.createdAt,
      updatedAt: caregiver.updatedAt,
      rejectionReasons: Array.isArray(caregiver.rejection_reasons)
        ? caregiver.rejection_reasons
        : undefined,
    };
  }
}
