/**
 * AdminService — Business logic สำหรับ admin operations
 *
 * Methods:
 * - adminKycList()   — ดึงรายการ KYC submissions พร้อม filter/search/pagination
 * - adminKycDetail() — ดึงรายละเอียด KYC ครบถ้วนของ caregiver แต่ละคน
 *
 * Query strategy:
 * - ใช้ Prisma raw query สำหรับ search (ILIKE) เนื่องจาก Prisma ไม่มี built-in ILIKE
 *   แต่ใช้ prisma.caregiver.findMany + where.fullName.contains (mode: 'insensitive') ได้เลย
 *   (Prisma จะแปลงเป็น ILIKE ให้อัตโนมัติบน PostgreSQL)
 * - Order: pending ก่อน (CASE WHEN), แล้วตาม kycSubmittedAt DESC
 */
import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../common/prisma.service';
import { CaregiverService } from '../identity/kyc/caregiver.service';
import { AdminKycListInput, KycStatusFilter } from './dto/admin-kyc-list.input';
import { AdminKycListPayload, CaregiverKycSummary } from './dto/admin-kyc-list.payload';
import { AdminKycDetailPayload } from './dto/admin-kyc-detail.payload';
import { Caregiver } from '../identity/kyc/entities/caregiver.entity';
import { KycReview } from '../identity/kyc/entities/kyc-review.entity';

/** Default pagination constants */
const DEFAULT_PAGE = 1;
const DEFAULT_LIMIT = 20;

@Injectable()
export class AdminService {
  private readonly logger = new Logger(AdminService.name);

  constructor(
    private readonly prismaService: PrismaService,
    private readonly caregiverService: CaregiverService,
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
}
