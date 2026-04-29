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
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../../common/prisma.service';
import { KycInput } from './dto/kyc.input';
import { Caregiver } from './entities/caregiver.entity';
import { KycStatusPayload } from './entities/kyc-status.payload';
import { AuthUser } from '../../common/decorators/current-user.decorator';
import { CaregiverService } from './caregiver.service';
import { NotificationService } from '../../notification/notification.service';
import { NotificationType } from '../../notification/entities/notification-type.enum';
import { EmailService } from '../../email/email.service';

// Statuses ที่อนุญาตให้ submit/resubmit ได้
// 'none'     = ครั้งแรก
// 'rejected' = resubmit หลังถูก admin reject (PYG-97)
// 'pending' / 'verified' = ห้าม submit ซ้ำ (กันรบกวน admin queue + กันแก้หลังผ่าน)
const SUBMITTABLE_STATUSES = new Set(['none', 'rejected']);

@Injectable()
export class KycService {
  private readonly logger = new Logger(KycService.name);

  constructor(
    private readonly prismaService: PrismaService,
    private readonly caregiverService: CaregiverService,
    private readonly notificationService: NotificationService,
    private readonly emailService: EmailService,
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
    // ต้องมีอยู่จริง + เป็นของ user คนนี้ (กัน user A ใช้ doc ของ user B)
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
      const upserted = await tx.caregiver.upsert({
        where: { userId: user.id },
        create: {
          userId: user.id,
          fullName: input.fullName,
          idCardNumber: input.idCardNumber,
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
          phone: input.phone,
          skills: input.skills,
          experienceYears: input.experienceYears,
          hourlyRate: input.hourlyRate,
          bio: input.bio,
          kycStatus: 'pending',
          kycSubmittedAt: new Date(),
          // ลบ kycVerifiedAt ออกในกรณี resubmit (เคลียร์สถานะ verify เก่า)
          // ถ้า case นี้ kycVerifiedAt ควรเป็น null อยู่แล้วเพราะมาจาก rejected — แต่ set ชัดเจนเพื่อความแน่นอน
          kycVerifiedAt: null,
        },
      });

      if (input.documentIds.length > 0) {
        await tx.kycDocument.updateMany({
          where: {
            id: { in: input.documentIds },
            userId: user.id,
          },
          data: { caregiverId: upserted.id },
        });
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
   * onKycVerified — เรียกจาก admin endpoint (Sprint 3) ตอน approve KYC (PYG-97)
   *
   * Side-effects:
   * - update caregiver.kycStatus = 'verified' + set kycVerifiedAt
   * - trigger notification (kyc_verified) + email
   *
   * @param caregiverId - UUID ของ caregiver ที่จะ approve
   * @returns Caregiver entity ที่ผ่านการ approve แล้ว
   * @throws NotFoundException ถ้าไม่พบ caregiver
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

  /** First-time KYC submit → kyc_submitted event */
  private async triggerKycSubmitted(
    userId: string,
    caregiverId: string,
  ): Promise<void> {
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

  /** Admin reject → kyc_rejected event (พร้อม reason) */
  private async triggerKycRejected(
    userId: string,
    caregiverId: string,
    reason: string,
  ): Promise<void> {
    try {
      await this.notificationService.create(
        userId,
        NotificationType.kyc_rejected,
        'ไม่ผ่านการตรวจสอบ',
        `เหตุผล: ${reason} — กรุณาส่งเอกสารใหม่`,
        { caregiverId, linkPath: '/kyc', reason },
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

  /**
   * getKycStatus — ดึงสถานะ KYC ของ user
   *
   * - ไม่พบ caregiver record → { status: 'none' }
   * - rejected → ดึง rejectedReason จาก KycReview ล่าสุด
   */
  async getKycStatus(userId: string): Promise<KycStatusPayload> {
    const caregiver = await this.prismaService.caregiver.findUnique({
      where: { userId },
    });

    if (!caregiver) {
      return { status: 'none' };
    }

    let rejectedReason: string | undefined;
    if (caregiver.kycStatus === 'rejected') {
      const latestReview = await this.prismaService.kycReview.findFirst({
        where: { caregiverId: caregiver.id, action: 'rejected' },
        orderBy: { reviewedAt: 'desc' },
        select: { reason: true },
      });
      rejectedReason = latestReview?.reason ?? undefined;
    }

    return {
      status: caregiver.kycStatus,
      submittedAt: caregiver.kycSubmittedAt ?? undefined,
      verifiedAt: caregiver.kycVerifiedAt ?? undefined,
      rejectedReason,
    };
  }

  /** Helper สำหรับ log error ที่ swallow ไว้ — ป้องกัน silent failure */
  private logCaught(action: string, userId: string, err: unknown): void {
    const msg = err instanceof Error ? err.message : String(err);
    this.logger.warn(`Failed to trigger "${action}" for user ${userId}: ${msg}`);
  }

  // ─── Private mapper ──────────────────────────────────────────────────

  /**
   * แปลง Prisma Caregiver → GraphQL Caregiver entity
   * ใช้ in submitKyc — fields ที่ submit ใหม่จะมีค่าเสมอ ใช้ ! ได้
   */
  private mapToEntity(caregiver: {
    id: string;
    userId: string;
    fullName: string | null;
    idCardNumber: string | null;
    phone: string | null;
    skills: string[];
    experienceYears: number | null;
    hourlyRate: number | null;
    bio: string | null;
    kycStatus: string;
    kycSubmittedAt: Date | null;
    kycVerifiedAt: Date | null;
    isSearchable: boolean;
    createdAt: Date;
    updatedAt: Date;
  }): Caregiver {
    return {
      id: caregiver.id,
      userId: caregiver.userId,
      fullName: caregiver.fullName!,
      idCardNumber: caregiver.idCardNumber!,
      phone: caregiver.phone!,
      skills: caregiver.skills,
      experienceYears: caregiver.experienceYears!,
      hourlyRate: caregiver.hourlyRate!,
      bio: caregiver.bio ?? undefined,
      kycStatus: caregiver.kycStatus,
      kycSubmittedAt: caregiver.kycSubmittedAt ?? undefined,
      kycVerifiedAt: caregiver.kycVerifiedAt ?? undefined,
      isSearchable: caregiver.isSearchable,
      createdAt: caregiver.createdAt,
      updatedAt: caregiver.updatedAt,
    };
  }
}
