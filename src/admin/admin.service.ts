/**
 * AdminService — Business logic สำหรับ admin operations
 *
 * Methods:
 * - adminKycList()   — ดึงรายการ KYC submissions พร้อม filter/search/pagination
 * - adminKycDetail() — ดึงรายละเอียด KYC ครบถ้วนของ caregiver แต่ละคน
 * - adminDashboard() — สรุปภาพรวม: stats, weekly submissions, avg review time, activity
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
  InternalServerErrorException,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import * as crypto from 'crypto';
import { PrismaService } from '../common/prisma.service';
import { SupabaseService } from '../common/supabase.service';
import { CaregiverService } from '../identity/kyc/caregiver.service';
import { NotificationService } from '../notification/notification.service';
import { EmailService } from '../email/email.service';
import { AdminKycListInput, KycStatusFilter } from './dto/admin-kyc-list.input';
import { AdminKycListPayload, CaregiverKycSummary } from './dto/admin-kyc-list.payload';
import { AdminKycDetailPayload } from './dto/admin-kyc-detail.payload';
import {
  AdminDashboardPayload,
  DashboardSummary,
  WeeklySubmission,
  RecentActivity,
} from './dto/admin-dashboard.payload';
import { RejectKycInput } from './dto/reject-kyc.input';
import { InviteAdminInput } from './dto/invite-admin.input';
import { InviteAdminPayload } from './dto/invite-admin.payload';
import { Caregiver } from '../identity/kyc/entities/caregiver.entity';
import { User } from '../identity/auth/entities/user.entity';
import { KycReview } from '../identity/kyc/entities/kyc-review.entity';
import { NotificationType } from '../notification/entities/notification-type.enum';
import { AuthUser } from '../common/decorators/current-user.decorator';
import { ROLE_ID } from '../common/constants/roles.constant';

/** Default pagination constants */
const DEFAULT_PAGE = 1;
const DEFAULT_LIMIT = 20;

@Injectable()
export class AdminService {
  private readonly logger = new Logger(AdminService.name);

  constructor(
    private readonly prismaService: PrismaService,
    private readonly supabaseService: SupabaseService,
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
  // DASHBOARD
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * adminDashboard — ดึงข้อมูลสรุปภาพรวมระบบ KYC สำหรับ admin dashboard
   *
   * ประกอบด้วย 4 sections (ยิงทุก query แบบ parallel เพื่อ performance):
   *
   * 1. Summary — COUNT users + caregivers + GROUP BY kyc_status
   *    SQL: COUNT(*) on users (is_deleted=false) + caregivers + grouped by kyc_status
   *
   * 2. Weekly submissions — DATE_TRUNC('week', kyc_submitted_at) last 8 weeks
   *    SQL: GROUP BY week, fill gaps with 0
   *
   * 3. Avg review time — AVG(kyc_verified_at - kyc_submitted_at) WHERE kyc_status = 'verified'
   *    SQL: EXTRACT(EPOCH FROM avg diff) / 3600 → hours
   *
   * 4. Recent activity — JOIN kyc_reviews + caregivers ORDER BY reviewed_at DESC LIMIT 10
   *
   * @returns AdminDashboardPayload
   */
  async adminDashboard(): Promise<AdminDashboardPayload> {
    // ── ยิงทุก query พร้อมกัน (independent — ไม่มี dependency ระหว่างกัน) ──
    const [summary, weeklySubmissions, avgReviewTimeHours, recentActivity] =
      await Promise.all([
        this.getDashboardSummary(),
        this.getWeeklySubmissions(),
        this.getAvgReviewTimeHours(),
        this.getRecentActivity(),
      ]);

    this.logger.log({
      event: 'admin.dashboard.queried',
      totalUsers: summary.totalUsers,
      totalCaregivers: summary.totalCaregivers,
      pendingKyc: summary.pendingKyc,
    });

    return {
      summary,
      weeklySubmissions,
      avgReviewTimeHours: avgReviewTimeHours ?? undefined,
      recentActivity,
    };
  }

  // ─── Dashboard sub-queries ────────────────────────────────────────────

  /**
   * getDashboardSummary — ตัวเลขสรุปภาพรวม
   *
   * DB columns used:
   * - users.is_deleted (filter out soft-deleted)
   * - caregivers.kyc_status (group by)
   */
  private async getDashboardSummary(): Promise<DashboardSummary> {
    // Query 1: total active users
    const totalUsers = await this.prismaService.user.count({
      where: { is_deleted: false },
    });

    // Query 2: caregiver counts grouped by kyc_status
    // Prisma groupBy จะ return array of { kycStatus, _count }
    const statusGroups = await this.prismaService.caregiver.groupBy({
      by: ['kycStatus'],
      _count: { _all: true },
    });

    // Map results → lookup
    const statusMap = new Map<string, number>();
    let totalCaregivers = 0;
    for (const group of statusGroups) {
      statusMap.set(group.kycStatus, group._count._all);
      totalCaregivers += group._count._all;
    }

    return {
      totalUsers,
      totalCaregivers,
      pendingKyc: statusMap.get('pending') ?? 0,
      verifiedKyc: statusMap.get('verified') ?? 0,
      rejectedKyc: statusMap.get('rejected') ?? 0,
    };
  }

  /**
   * getWeeklySubmissions — จำนวน KYC submissions 8 สัปดาห์ล่าสุด
   *
   * Strategy:
   * - $queryRaw เพราะ Prisma ไม่มี DATE_TRUNC groupBy
   * - DB column: caregivers.kyc_submitted_at
   * - Fill missing weeks with 0 count (frontend ต้องการ array ครบทุกสัปดาห์เพื่อวาด chart)
   */
  private async getWeeklySubmissions(): Promise<WeeklySubmission[]> {
    // 8 weeks ago = จุดเริ่มต้น (Monday ต้นสัปดาห์)
    const eightWeeksAgo = new Date();
    eightWeeksAgo.setDate(eightWeeksAgo.getDate() - 8 * 7);
    // Align to Monday (JS: getDay() 0=Sun, 1=Mon, ...)
    const day = eightWeeksAgo.getDay();
    const diff = day === 0 ? -6 : 1 - day; // ถ้า Sunday (-6), อื่นๆ (1 - day)
    eightWeeksAgo.setDate(eightWeeksAgo.getDate() + diff);
    eightWeeksAgo.setHours(0, 0, 0, 0);

    // Raw SQL: DATE_TRUNC('week', kyc_submitted_at) grouped + counted
    // PostgreSQL DATE_TRUNC('week', ...) returns Monday 00:00:00 of each week
    const rows = await this.prismaService.$queryRaw<
      Array<{ week: Date; count: bigint }>
    >`
      SELECT
        DATE_TRUNC('week', kyc_submitted_at) AS week,
        COUNT(*)::bigint AS count
      FROM caregivers
      WHERE kyc_submitted_at IS NOT NULL
        AND kyc_submitted_at >= ${eightWeeksAgo}
      GROUP BY week
      ORDER BY week ASC
    `;

    // Build lookup from DB results
    const dbMap = new Map<string, number>();
    for (const row of rows) {
      const key = row.week.toISOString().slice(0, 10); // YYYY-MM-DD
      dbMap.set(key, Number(row.count));
    }

    // Generate all 8 weeks (fill gaps with 0)
    const result: WeeklySubmission[] = [];
    const cursor = new Date(eightWeeksAgo);
    for (let i = 0; i < 8; i++) {
      const key = cursor.toISOString().slice(0, 10);
      result.push({
        week: key,
        count: dbMap.get(key) ?? 0,
      });
      cursor.setDate(cursor.getDate() + 7);
    }

    return result;
  }

  /**
   * getAvgReviewTimeHours — เวลาเฉลี่ยระหว่าง submit → verified (ชั่วโมง)
   *
   * Strategy:
   * - $queryRaw เพราะ Prisma ไม่มี AVG ของ date diff
   * - DB columns: kyc_verified_at, kyc_submitted_at → diff in seconds → / 3600
   * - เฉพาะ caregivers ที่ kyc_status = 'verified' + มีทั้งสอง timestamps
   * - Return null ถ้าไม่มี data
   */
  private async getAvgReviewTimeHours(): Promise<number | null> {
    const rows = await this.prismaService.$queryRaw<
      Array<{ avg_hours: number | null }>
    >`
      SELECT
        EXTRACT(EPOCH FROM AVG(kyc_verified_at - kyc_submitted_at)) / 3600.0
          AS avg_hours
      FROM caregivers
      WHERE kyc_status = 'verified'
        AND kyc_verified_at IS NOT NULL
        AND kyc_submitted_at IS NOT NULL
    `;

    const avgHours = rows[0]?.avg_hours;
    if (avgHours == null) return null;

    // Round to 1 decimal place (เช่น 4.3 hours)
    return Math.round(avgHours * 10) / 10;
  }

  /**
   * getRecentActivity — 10 กิจกรรม admin review ล่าสุด
   *
   * Strategy:
   * - $queryRaw เพราะต้อง JOIN kyc_reviews + caregivers → full_name
   * - ORDER BY reviewed_at DESC LIMIT 10
   * - DB columns: kyc_reviews.caregiver_id, reviewed_at, action
   *               caregivers.full_name
   */
  private async getRecentActivity(): Promise<RecentActivity[]> {
    const rows = await this.prismaService.$queryRaw<
      Array<{
        full_name: string | null;
        action: string;
        reviewed_at: Date;
      }>
    >`
      SELECT
        c.full_name,
        r.action,
        r.reviewed_at
      FROM kyc_reviews r
      INNER JOIN caregivers c ON c.id = r.caregiver_id
      ORDER BY r.reviewed_at DESC
      LIMIT 10
    `;

    return rows.map((row) => ({
      type: 'kyc_review',
      caregiverName: row.full_name ?? 'Unknown',
      action: row.action,
      timestamp: row.reviewed_at,
    }));
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
  // INVITE ADMIN
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * inviteAdmin — Super Admin เชิญ Admin หรือ Super Admin ใหม่
   *
   * Flow:
   * 1. Validate email uniqueness — ConflictException ถ้าซ้ำ
   * 2. Validate role — BadRequestException ถ้าไม่ใช่ 3 หรือ 4
   * 3. Generate temp password (12-char base64)
   * 4. Create Supabase Auth user (email_confirm: true — skip verification)
   * 5. Create user record ใน DB (must_change_password: true)
   * 6. Send invitation email พร้อม temp password (fire-and-forget)
   * 7. Audit log (console placeholder — admin_audit_logs ยังไม่มี table)
   * 8. Return { user, tempPasswordSent: true }
   *
   * @param input       - InviteAdminInput (email, firstName, lastName, role)
   * @param currentUser - Super Admin ที่กำลัง invite (จาก JWT)
   */
  async inviteAdmin(input: InviteAdminInput, currentUser: AuthUser): Promise<InviteAdminPayload> {
    // ─── 1. Validate email uniqueness ─────────────────────────────────────
    const existing = await this.prismaService.user.findUnique({
      where: { email: input.email },
    });
    if (existing) {
      throw new ConflictException('Email already registered');
    }

    // ─── 2. Validate role ─────────────────────────────────────────────────
    if (input.role !== ROLE_ID.ADMIN && input.role !== ROLE_ID.SUPER_ADMIN) {
      throw new BadRequestException('Invalid role. Must be 3 (ADMIN) or 4 (SUPER_ADMIN)');
    }

    // ─── 3. Generate temp password ────────────────────────────────────────
    const tempPassword = crypto.randomBytes(9).toString('base64'); // 12 chars

    // ─── 4. Create Supabase Auth user ─────────────────────────────────────
    const supabaseAdmin = this.supabaseService.getAdminClient();
    const { data: authData, error: authError } = await supabaseAdmin.auth.admin.createUser({
      email: input.email,
      password: tempPassword,
      email_confirm: true,
    });

    if (authError || !authData.user) {
      this.logger.error(`Supabase admin.createUser failed for ${input.email}: ${authError?.message ?? 'no user returned'}`);
      throw new InternalServerErrorException('Failed to create auth user');
    }

    // ─── 5. Create user record in DB ──────────────────────────────────────
    const displayName = `${input.firstName} ${input.lastName}`;
    const created = await this.prismaService.user.create({
      data: {
        supabaseUid: authData.user.id,
        email: input.email,
        displayName,
        role: input.role,
        isActive: true,
        must_change_password: true,
        invited_by: currentUser.id,
      },
    });

    // ─── 6. Send invitation email (fire-and-forget) ───────────────────────
    void this.emailService.sendAdminInvite(created.email, created.displayName, tempPassword).catch((err: unknown) => {
      this.logSideEffectError('email admin_invite', created.id, err);
    });

    // ─── 7. Audit log placeholder ─────────────────────────────────────────
    // TODO: replace with admin_audit_logs table insert when table is created (PYG-127)
    this.logger.log({
      event: 'admin.invited',
      invitedBy: currentUser.id,
      targetEmail: input.email,
      targetUserId: created.id,
      role: input.role,
    });

    // ─── 8. Return ────────────────────────────────────────────────────────
    return { user: this.mapToUser(created), tempPasswordSent: true };
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

  /** mapToUser — แปลง Prisma user record → GraphQL User entity */
  private mapToUser(u: {
    id: string;
    email: string;
    displayName: string | null;
    avatarUrl: string | null;
    phone: string | null;
    address: string | null;
    bio: string | null;
    role: number;
    isActive: boolean;
    emailPreferences: boolean;
    createdAt: Date;
    updatedAt: Date;
  }): User {
    return {
      id: u.id,
      email: u.email,
      displayName: u.displayName ?? undefined,
      avatarUrl: u.avatarUrl ?? undefined,
      phone: u.phone ?? undefined,
      address: u.address ?? undefined,
      bio: u.bio ?? undefined,
      role: u.role,
      isActive: u.isActive,
      emailPreferences: u.emailPreferences,
      createdAt: u.createdAt,
      updatedAt: u.updatedAt,
    };
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
