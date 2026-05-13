/**
 * AdminService — Business logic สำหรับ admin operations
 *
 * Methods:
 * - adminKycList()   — ดึงรายการ KYC submissions พร้อม filter/search/pagination
 * - adminKycDetail() — ดึงรายละเอียด KYC ครบถ้วนของ caregiver แต่ละคน
 * - approveKyc()     — admin อนุมัติ KYC: verify caregiver + บันทึก audit + notify
 * - rejectKyc()      — admin ปฏิเสธ KYC: reject caregiver + บันทึก audit + notify
 *
 * Query strategy:
 * - ใช้ Prisma raw query สำหรับ search (ILIKE) เนื่องจาก Prisma ไม่มี built-in ILIKE
 *   แต่ใช้ prisma.caregiver.findMany + where.fullName.contains (mode: 'insensitive') ได้เลย
 *   (Prisma จะแปลงเป็น ILIKE ให้อัตโนมัติบน PostgreSQL)
 * - Order: pending ก่อน (CASE WHEN), แล้วตาม kycSubmittedAt DESC
 *
 * Error handling for approve/reject:
 * - kycStatus = 'none'     → BadRequestException (ยังไม่เคย submit)
 * - kycStatus = 'verified' → ConflictException (อนุมัติไปแล้ว)
 * - kycStatus = 'rejected' → ConflictException (reject ไปแล้ว)
 * - kycStatus = 'pending'  → ดำเนินการได้
 */
import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../common/prisma.service';
import { CaregiverService } from '../identity/kyc/caregiver.service';
import { NotificationService } from '../notification/notification.service';
import { EmailService } from '../email/email.service';
import { AdminKycListInput, KycStatusFilter } from './dto/admin-kyc-list.input';
import { AdminKycListPayload, CaregiverKycSummary } from './dto/admin-kyc-list.payload';
import { AdminKycDetailPayload } from './dto/admin-kyc-detail.payload';
import { RejectKycInput } from './dto/reject-kyc.input';
import { Caregiver } from '../identity/kyc/entities/caregiver.entity';
import { KycReview } from '../identity/kyc/entities/kyc-review.entity';
import { NotificationType } from '../notification/entities/notification-type.enum';
import { AuthUser } from '../common/decorators/current-user.decorator';

/** Default pagination constants */
const DEFAULT_PAGE = 1;
const DEFAULT_LIMIT = 20;

@Injectable()
export class AdminService {
  private readonly logger = new Logger(AdminService.name);

  constructor(
    private readonly prismaService: PrismaService,
    private readonly caregiverService: CaregiverService,
    private readonly notificationService: NotificationService,
    private readonly emailService: EmailService,
  ) { }

  /**
   * adminKycList — ดึงรายการ KYC submissions สำหรับ admin
   *
   * Logic:
   * 1. สร้าง where clause จาก status + search filter
   * 2. นับ total (สำหรับ pagination)
   * 3. Query caregivers พร้อม _count.kycDocuments (documentCount)
   * 4. Sort: pending ก่อน → kycSubmittedAt DESC → createdAt DESC
   * 5. Apply offset pagination
   * 6. Map ไป CaregiverKycSummary[]
   *
   * @param input - filter/search/pagination options
   * @returns AdminKycListPayload
   */
  async adminKycList(input: AdminKycListInput): Promise<AdminKycListPayload> {
    const page = input.page ?? DEFAULT_PAGE;
    const limit = input.limit ?? DEFAULT_LIMIT;
    const offset = (page - 1) * limit;

    // ─── 1. Build where clause ────────────────────────────────────────────
    const where: Parameters<typeof this.prismaService.caregiver.findMany>[0]['where'] = {};

    // Filter by status (ถ้าไม่ส่ง หรือส่ง "all" → ไม่กรอง)
    if (input.status && input.status !== KycStatusFilter.all) {
      where.kycStatus = input.status;
    }

    // Search by fullName (ILIKE — Prisma mode: 'insensitive' → PostgreSQL ILIKE)
    if (input.search && input.search.trim() !== '') {
      where.fullName = {
        contains: input.search.trim(),
        mode: 'insensitive',
      };
    }

    // ─── 2. Count total matching records ─────────────────────────────────
    const total = await this.prismaService.caregiver.count({ where });

    // ─── 3. Query caregivers + document count ────────────────────────────
    //
    // _count.kycDocuments → นับจำนวน KycDocument ที่ link กับ caregiver นี้
    //
    // Ordering strategy (pending first):
    //   Prisma ไม่รองรับ CASE WHEN ใน orderBy โดยตรง
    //   → ใช้ findMany แล้วเรียงใน JS แทน (total records per page ≤ 100 ปลอดภัย)
    //   หรือใช้ $queryRaw ถ้าต้องการ performance ดีกว่า
    //
    //   เลือก JS sort เพราะ:
    //   - Simple และ maintainable
    //   - limit สูงสุด 100 rows → in-memory sort ไม่เป็นปัญหา
    //   - ถ้าในอนาคตต้องการ scale → migrate เป็น $queryRaw ได้ง่าย
    const caregivers = await this.prismaService.caregiver.findMany({
      where,
      select: {
        id: true,
        fullName: true,
        kycStatus: true,
        kycSubmittedAt: true,
        createdAt: true,
        _count: {
          select: { documents: true },
        },
      },
      // ดึง slice ที่ถูกต้องก่อน sort (over-fetch เพื่อ sort แล้ว slice จะเสีย pagination)
      // ดังนั้น ดึงทั้งหน้าก่อนแล้ว sort แล้ว skip/take
      // NOTE: เราต้องดึงทุก record ที่ match filter เพื่อ sort แล้ว slice
      //       แต่เพื่อ performance เราจะ sort ใน DB ด้วย orderBy ที่ใกล้เคียงที่สุด
      //       แล้วใช้ JS sort เฉพาะ pending-first logic
      skip: offset,
      take: limit,
      orderBy: [
        // Secondary sort ใน DB: kycSubmittedAt DESC (null ท้ายสุด), createdAt DESC
        // pending-first จะทำใน JS หลัง fetch
        { kycSubmittedAt: 'desc' },
        { createdAt: 'desc' },
      ],
    });

    // ─── 4. Sort: pending first, then by kycSubmittedAt DESC ─────────────
    //
    // เรา fetch แบบ offset-based → sort หลัง fetch ใน current page
    // ถ้าต้องการ strict cross-page ordering ต้องใช้ $queryRaw + CASE WHEN ORDER BY
    // สำหรับ admin list ที่ admin browse ทีละหน้า วิธีนี้เพียงพอ
    const sorted = [...caregivers].sort((a, b) => {
      const aIsPending = a.kycStatus === 'pending' ? 0 : 1;
      const bIsPending = b.kycStatus === 'pending' ? 0 : 1;

      // pending ก่อน
      if (aIsPending !== bIsPending) return aIsPending - bIsPending;

      // ถ้า status เดียวกัน → เรียงตาม kycSubmittedAt DESC (null ไปท้ายสุด)
      const aTime = a.kycSubmittedAt?.getTime() ?? 0;
      const bTime = b.kycSubmittedAt?.getTime() ?? 0;
      return bTime - aTime;
    });

    // ─── 5. Compute totalPages ────────────────────────────────────────────
    const totalPages = total === 0 ? 1 : Math.ceil(total / limit);

    // ─── 6. Map to CaregiverKycSummary ───────────────────────────────────
    const items: CaregiverKycSummary[] = sorted.map((c) => ({
      id: c.id,
      fullName: c.fullName ?? '',
      kycStatus: c.kycStatus,
      submittedAt: c.kycSubmittedAt ?? undefined,
      documentCount: c._count.documents,
    }));

    this.logger.log({
      event: 'admin.kyc_list.queried',
      filter: { status: input.status, search: !!input.search },
      total,
      page,
      limit,
      returned: items.length,
    });

    return { items, total, page, totalPages };
  }

  /**
   * adminKycDetail — ดึงรายละเอียด KYC ครบถ้วนของ caregiver แต่ละคน
   *
   * Logic:
   * 1. Query caregiver → NotFoundException ถ้าไม่พบ
   * 2. ดึง KYC documents พร้อม signed URLs (via CaregiverService)
   * 3. ดึง review history จาก kyc_reviews table เรียงล่าสุดก่อน
   * 4. Return AdminKycDetailPayload
   *
   * @param caregiverId - UUID ของ caregiver
   * @returns AdminKycDetailPayload
   * @throws NotFoundException ถ้าไม่พบ caregiver
   */
  async adminKycDetail(caregiverId: string): Promise<AdminKycDetailPayload> {
    // ─── 1. Fetch caregiver ───────────────────────────────────────────────
    const raw = await this.prismaService.caregiver.findUnique({
      where: { id: caregiverId },
    });

    if (!raw) {
      throw new NotFoundException(`Caregiver ${caregiverId} not found`);
    }

    const caregiver: Caregiver = {
      id: raw.id,
      userId: raw.userId,
      caregiverNumber: raw.caregiverNumber ?? undefined,
      fullName: raw.fullName ?? '',
      idCardNumber: raw.idCardNumber ?? '',
      gender: raw.gender ?? undefined,
      dateOfBirth: raw.dateOfBirth ?? undefined,
      address: raw.address ?? undefined,
      phone: raw.phone ?? '',
      skills: raw.skills,
      experienceYears: raw.experienceYears ?? 0,
      hourlyRate: raw.hourlyRate ?? 0,
      bio: raw.bio ?? undefined,
      kycStatus: raw.kycStatus,
      kycSubmittedAt: raw.kycSubmittedAt ?? undefined,
      kycVerifiedAt: raw.kycVerifiedAt ?? undefined,
      isSearchable: raw.isSearchable,
      resubmitCount: raw.resubmitCount,
      createdAt: raw.createdAt,
      updatedAt: raw.updatedAt,
    };

    // ─── 2. Fetch documents with signed URLs ─────────────────────────────
    const documents = await this.caregiverService.getDocumentsWithSignedUrls(caregiverId);

    // ─── 3. Fetch review history (newest first) ──────────────────────────
    const rawReviews = await this.prismaService.kycReview.findMany({
      where: { caregiverId },
      orderBy: { reviewedAt: 'desc' },
    });

    const reviews: KycReview[] = rawReviews.map((r) => ({
      id: r.id,
      action: r.action,
      reason: r.reason ?? undefined,
      reviewedBy: r.reviewerId,
      reviewedAt: r.reviewedAt,
    }));

    this.logger.log({
      event: 'admin.kyc_detail.queried',
      caregiverId,
      documentCount: documents.length,
      reviewCount: reviews.length,
    });

    return {
      caregiver,
      documents,
      reviews,
      resubmitCount: raw.resubmitCount,
    };
  }

  // ─────────────────────────────────────────────────────────────────────────
  // KYC APPROVE / REJECT
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * approveKyc — admin อนุมัติ KYC submission
   *
   * Flow:
   * 1. Fetch caregiver → NotFoundException ถ้าไม่พบ
   * 2. Guard kycStatus:
   *    - 'none'     → BadRequestException (ยังไม่เคย submit)
   *    - 'verified' → ConflictException (อนุมัติไปแล้ว)
   *    - 'rejected' → ConflictException (reject ไปแล้ว ต้อง resubmit ก่อน)
   *    - 'pending'  → ดำเนินการได้
   * 3. Transaction: update kycStatus = 'verified' + INSERT kyc_review
   * 4. Trigger notification + email (fire-and-forget — error ไม่ทำให้ fail)
   * 5. Return updated Caregiver
   *
   * @param caregiverId - UUID ของ caregiver ที่จะ approve
   * @param admin       - admin user ที่กำลัง approve (สำหรับ audit trail)
   */
  async approveKyc(caregiverId: string, admin: AuthUser): Promise<Caregiver> {
    // ─── 1. Fetch + guard ─────────────────────────────────────────────────
    const existing = await this.prismaService.caregiver.findUnique({
      where: { id: caregiverId },
    });

    if (!existing) {
      throw new NotFoundException(`Caregiver "${caregiverId}" not found`);
    }

    this.assertReviewable(existing.kycStatus, 'approve');

    // ─── 2. Transaction: update status + INSERT audit record ──────────────
    const updated = await this.prismaService.$transaction(async (tx) => {
      const caregiver = await tx.caregiver.update({
        where: { id: caregiverId },
        data: {
          kycStatus: 'verified',
          kycVerifiedAt: new Date(),
        },
      });

      await tx.kycReview.create({
        data: {
          caregiverId,
          reviewerId: admin.id,
          action: 'approved',
          // reason ไม่มีสำหรับ approve
        },
      });

      return caregiver;
    });

    this.logger.log({
      event: 'admin.kyc.approved',
      caregiverId,
      adminId: admin.id,
    });

    // ─── 3. Side-effects (fire-and-forget) ───────────────────────────────
    void this.triggerApproveNotify(updated.userId, caregiverId);

    return this.mapToCaregiver(updated);
  }

  /**
   * rejectKyc — admin ปฏิเสธ KYC submission
   *
   * Flow:
   * 1. Fetch caregiver → NotFoundException ถ้าไม่พบ
   * 2. Guard kycStatus (เหมือน approveKyc)
   * 3. Transaction: update kycStatus = 'rejected' + INSERT kyc_review (พร้อม reason)
   * 4. Trigger notification + email พร้อม reason (fire-and-forget)
   * 5. Return updated Caregiver
   *
   * @param input - RejectKycInput (caregiverId + reason min 10 chars)
   * @param admin - admin user ที่กำลัง reject (สำหรับ audit trail)
   */
  async rejectKyc(input: RejectKycInput, admin: AuthUser): Promise<Caregiver> {
    // ─── 1. Fetch + guard ─────────────────────────────────────────────────
    const existing = await this.prismaService.caregiver.findUnique({
      where: { id: input.caregiverId },
    });

    if (!existing) {
      throw new NotFoundException(`Caregiver "${input.caregiverId}" not found`);
    }

    this.assertReviewable(existing.kycStatus, 'reject');

    // ─── 2. Transaction: update status + INSERT audit record ──────────────
    const updated = await this.prismaService.$transaction(async (tx) => {
      const caregiver = await tx.caregiver.update({
        where: { id: input.caregiverId },
        data: {
          kycStatus: 'rejected',
          // kycVerifiedAt ไม่ set (เคย set ไว้ก็ clear ออก เพื่อความถูกต้อง)
          kycVerifiedAt: null,
        },
      });

      await tx.kycReview.create({
        data: {
          caregiverId: input.caregiverId,
          reviewerId: admin.id,
          action: 'rejected',
          reason: input.reason,
        },
      });

      return caregiver;
    });

    this.logger.log({
      event: 'admin.kyc.rejected',
      caregiverId: input.caregiverId,
      adminId: admin.id,
      reasonLength: input.reason.length,
    });

    // ─── 3. Side-effects (fire-and-forget) ───────────────────────────────
    void this.triggerRejectNotify(updated.userId, input.caregiverId, input.reason);

    return this.mapToCaregiver(updated);
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Private helpers
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * assertReviewable — ตรวจสอบว่า KYC status อนุญาตให้ approve/reject ได้
   *
   * Status ที่ reviewable ได้ = 'pending' เท่านั้น
   * - 'none'     → admin ยังไม่ควร review (caregiver ยังไม่ submit)
   * - 'verified' → อนุมัติไปแล้ว (ไม่ควร approve/reject ซ้ำ)
   * - 'rejected' → reject ไปแล้ว รอ caregiver resubmit
   *
   * @param currentStatus - kycStatus ปัจจุบัน
   * @param intent        - 'approve' | 'reject' (สำหรับ error message ที่ชัดเจน)
   */
  private assertReviewable(currentStatus: string, intent: 'approve' | 'reject'): void {
    if (currentStatus === 'none') {
      throw new BadRequestException(
        `Cannot ${intent} KYC: caregiver has not submitted KYC yet (status: "none")`,
      );
    }
    if (currentStatus === 'verified') {
      throw new ConflictException(
        `Cannot ${intent} KYC: already verified`,
      );
    }
    if (currentStatus === 'rejected') {
      throw new ConflictException(
        `Cannot ${intent} KYC: already rejected — waiting for caregiver to resubmit`,
      );
    }
    // 'pending' → ผ่าน (ไม่ throw)
  }

  /**
   * triggerApproveNotify — ส่ง notification + email หลัง approve (fire-and-forget)
   * Error ใดๆ จาก side-effect จะถูก log เท่านั้น ไม่ทำให้ mutation fail
   */
  private async triggerApproveNotify(userId: string, caregiverId: string): Promise<void> {
    try {
      await this.notificationService.create(
        userId,
        NotificationType.kyc_verified,
        'ยืนยันตัวตนสำเร็จ 🎉',
        'คุณสามารถเริ่มรับงานได้แล้ว',
        { caregiverId, linkPath: '/dashboard' },
      );
    } catch (err) {
      this.logSideEffectError('notification kyc_verified', userId, err);
    }

    try {
      await this.emailService.sendKycVerified(userId);
    } catch (err) {
      this.logSideEffectError('email kyc_verified', userId, err);
    }
  }

  /**
   * triggerRejectNotify — ส่ง notification + email หลัง reject (fire-and-forget)
   */
  private async triggerRejectNotify(
    userId: string,
    caregiverId: string,
    reason: string,
  ): Promise<void> {
    try {
      await this.notificationService.create(
        userId,
        NotificationType.kyc_rejected,
        'การยืนยันตัวตนไม่ผ่าน',
        `เหตุผล: ${reason}`,
        { caregiverId, linkPath: '/kyc/resubmit' },
      );
    } catch (err) {
      this.logSideEffectError('notification kyc_rejected', userId, err);
    }

    try {
      await this.emailService.sendKycRejected(userId, reason);
    } catch (err) {
      this.logSideEffectError('email kyc_rejected', userId, err);
    }
  }

  /** Log side-effect errors โดยไม่ throw */
  private logSideEffectError(action: string, userId: string, error: unknown): void {
    const msg = error instanceof Error ? error.message : String(error);
    const stack = error instanceof Error ? error.stack : undefined;
    this.logger.error(
      `[AdminService] Failed side-effect "${action}" for user ${userId}: ${msg}`,
      stack,
    );
  }

  /**
   * mapToCaregiver — แปลง Prisma caregiver record → GraphQL Caregiver entity
   * (เหมือน pattern ที่ CaregiverService ใช้)
   */
  private mapToCaregiver(c: {
    id: string;
    userId: string;
    caregiverNumber: string | null;
    fullName: string | null;
    idCardNumber: string | null;
    gender: string | null;
    dateOfBirth: Date | null;
    address: string | null;
    phone: string | null;
    skills: string[];
    experienceYears: number | null;
    hourlyRate: number | null;
    bio: string | null;
    kycStatus: string;
    kycSubmittedAt: Date | null;
    kycVerifiedAt: Date | null;
    isSearchable: boolean;
    resubmitCount: number;
    createdAt: Date;
    updatedAt: Date;
  }): Caregiver {
    return {
      id: c.id,
      userId: c.userId,
      caregiverNumber: c.caregiverNumber ?? undefined,
      fullName: c.fullName ?? '',
      idCardNumber: c.idCardNumber ?? '',
      gender: c.gender ?? undefined,
      dateOfBirth: c.dateOfBirth ?? undefined,
      address: c.address ?? undefined,
      phone: c.phone ?? '',
      skills: c.skills,
      experienceYears: c.experienceYears ?? 0,
      hourlyRate: c.hourlyRate ?? 0,
      bio: c.bio ?? undefined,
      kycStatus: c.kycStatus,
      kycSubmittedAt: c.kycSubmittedAt ?? undefined,
      kycVerifiedAt: c.kycVerifiedAt ?? undefined,
      isSearchable: c.isSearchable,
      resubmitCount: c.resubmitCount,
      createdAt: c.createdAt,
      updatedAt: c.updatedAt,
    };
  }
}
