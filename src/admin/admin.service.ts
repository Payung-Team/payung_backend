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
import { Prisma } from '@prisma/client';
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
import { RejectionReasonItem } from './dto/rejection-reason.input';
import { InviteAdminInput } from './dto/invite-admin.input';
import { InviteAdminPayload } from './dto/invite-admin.payload';
import { ToggleAdminStatusInput } from './dto/toggle-admin-status.input';
import { ToggleAdminStatusPayload } from './dto/toggle-admin-status.payload';
import { ScheduleDeleteAdminInput } from './dto/schedule-delete-admin.input';
import { ScheduleDeleteAdminPayload } from './dto/schedule-delete-admin.payload';
import { CancelScheduledDeleteInput } from './dto/cancel-scheduled-delete.input';
import { CancelScheduledDeletePayload } from './dto/cancel-scheduled-delete.payload';
import { EditAdminInfoInput } from './dto/edit-admin-info.input';
import { EditAdminInfoPayload } from './dto/edit-admin-info.payload';
import { AdminEditUserInput } from './dto/admin-edit-user.input';
import { AdminUpdateCaregiverInfoInput } from './dto/admin-update-caregiver-info.input';
import { AdminUpdateCaregiverInfoPayload } from './dto/admin-update-caregiver-info.payload';
import { AdminUserListInput, ROLE_FILTER_MAP } from './dto/admin-user-list.input';
import { AdminUserListPayload, UserSummary } from './dto/admin-user-list.payload';
import { AdminUserDetailPayload } from './dto/admin-user-detail.payload';
import { ChangeUserRoleInput } from './dto/change-user-role.input';
import { ToggleFieldLockInput, EntityTypeEnum } from './dto/toggle-field-lock.input';
import { FieldLockResult, LockedField } from './dto/field-lock.payload';
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
    const where: Prisma.CaregiverWhereInput = {};

    // Filter by status
    if (input.status && input.status !== KycStatusFilter.all) {
      where.kycStatus = input.status;
    } else {
      // สำหรับ "all" (หรือไม่ได้ระบุ status) ให้โชว์แค่คนที่กำลังอยู่หรือผ่านขั้นตอน KYC แล้ว (ไม่เอา none)
      where.kycStatus = { in: ['pending', 'verified', 'rejected'] };
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
        caregiverNumber: true,
        fullName: true,
        kycStatus: true,
        kycSubmittedAt: true,
        createdAt: true,
        user: {
          select: { email: true },
        },
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
      caregiverNumber: c.caregiverNumber ?? undefined,
      fullName: c.fullName ?? '',
      email: c.user?.email ?? '',
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
      include: { user: true },
    });

    if (!raw) {
      throw new NotFoundException(`Caregiver ${caregiverId} not found`);
    }

    const caregiver = this.mapToCaregiver(raw);

    // ─── 2. Fetch documents with signed URLs ─────────────────────────────
    const documents = await this.caregiverService.getDocumentsWithSignedUrls(caregiverId);

    // ─── 3. Fetch review history (newest first) + reviewer name via JOIN ──
    const rawReviews = await this.prismaService.kycReview.findMany({
      where: { caregiverId },
      orderBy: { reviewedAt: 'desc' },
      include: {
        reviewer: {
          select: { displayName: true },
        },
      },
    });

    const reviews: KycReview[] = rawReviews.map((r) => ({
      id: r.id,
      action: r.action,
      reason: r.reason ?? undefined,
      reviewedBy: r.reviewerId,
      reviewerName: r.reviewer?.displayName ?? undefined,
      reviewedAt: r.reviewedAt,
    }));

    // ─── 4. Fetch caregiver edit history ($queryRaw — model not yet in generated client) ──
    const rawEditLogs = await this.prismaService.$queryRaw<
      Array<{
        id: string;
        caregiver_id: string;
        edited_by: string;
        editor_name: string | null;
        action: string;
        field_changes: unknown;
        created_at: Date;
      }>
    >`
      SELECT
        el.id,
        el.caregiver_id,
        el.edited_by,
        u.display_name AS editor_name,
        el.action,
        el.field_changes,
        el.created_at
      FROM caregiver_edit_logs el
      LEFT JOIN users u ON u.id = el.edited_by
      WHERE el.caregiver_id = ${caregiverId}
      ORDER BY el.created_at DESC
    `;

    const editHistory = rawEditLogs.map((log) => ({
      id: log.id,
      caregiverId: log.caregiver_id,
      editedBy: log.edited_by,
      editorName: log.editor_name ?? undefined,
      action: log.action,
      fieldChanges: Array.isArray(log.field_changes) ? log.field_changes : undefined,
      createdAt: log.created_at,
    }));

    // ─── 5. Fetch admin audit logs (lock/unlock + caregiver info edits) ─────
    const rawAuditLogs = await this.prismaService.$queryRaw<
      Array<{
        id: string;
        action: string;
        details: unknown;
        created_at: Date;
        editor_name: string | null;
        admin_id: string;
      }>
    >`
      SELECT
        aal.id,
        aal.action,
        aal.details,
        aal.created_at,
        u.display_name AS editor_name,
        aal.admin_id
      FROM admin_audit_logs aal
      LEFT JOIN users u ON u.id = aal.admin_id
      WHERE (
        (aal.action IN ('FIELD_LOCK', 'FIELD_UNLOCK') AND aal.target_user_id = ${caregiverId})
        OR
        (aal.action = 'CAREGIVER_INFO_UPDATED' AND aal.target_user_id = ${raw.userId})
      )
      ORDER BY aal.created_at DESC
    `;

    const adminAuditItems = rawAuditLogs.map((log) => {
      const details = (log.details ?? {}) as Record<string, unknown>;

      if (log.action === 'FIELD_LOCK' || log.action === 'FIELD_UNLOCK') {
        const fieldName = (details.fieldName as string | undefined) ?? '';
        return {
          id: `audit-${log.id}`,
          caregiverId,
          editedBy: log.admin_id,
          editorName: log.editor_name ?? undefined,
          action: log.action === 'FIELD_LOCK' ? 'field_lock' : 'field_unlock',
          fieldChanges: fieldName
            ? [{ field: fieldName, oldValue: undefined, newValue: undefined }]
            : undefined,
          createdAt: log.created_at,
        };
      }

      // CAREGIVER_INFO_UPDATED
      const fieldChanges = Object.entries(details).map(([field, change]) => {
        const c = change as { from?: unknown; to?: unknown } | undefined;
        return {
          field,
          oldValue: c?.from != null ? String(c.from) : undefined,
          newValue: c?.to != null ? String(c.to) : undefined,
        };
      });
      return {
        id: `audit-${log.id}`,
        caregiverId,
        editedBy: log.admin_id,
        editorName: log.editor_name ?? undefined,
        action: 'admin_edit',
        fieldChanges: fieldChanges.length > 0 ? fieldChanges : undefined,
        createdAt: log.created_at,
      };
    });

    const mergedHistory = [...editHistory, ...adminAuditItems].sort(
      (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
    );

    this.logger.log({
      event: 'admin.kyc_detail.queried',
      caregiverId,
      documentCount: documents.length,
      reviewCount: reviews.length,
      editHistoryCount: mergedHistory.length,
    });

    return {
      caregiver,
      documents,
      reviews,
      resubmitCount: raw.resubmitCount,
      editHistory: mergedHistory,
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
    // 8 weeks ago — aligned to Monday 00:00:00 UTC (matches PostgreSQL DATE_TRUNC('week',...))
    // Using UTC methods throughout so cursor keys match DB-returned week keys regardless of server timezone
    const now = new Date();
    const eightWeeksAgo = new Date(Date.UTC(
      now.getUTCFullYear(),
      now.getUTCMonth(),
      now.getUTCDate() - 8 * 7,
    ));
    const dayUTC = eightWeeksAgo.getUTCDay(); // 0=Sun, 1=Mon, …
    const diff = dayUTC === 0 ? -6 : 1 - dayUTC;
    eightWeeksAgo.setUTCDate(eightWeeksAgo.getUTCDate() + diff);
    // eightWeeksAgo is now Monday 00:00:00 UTC

    // Run both queries concurrently
    const [submissionRows, approvalRows] = await Promise.all([
      // Line 1: KYC submissions per week (by kyc_submitted_at)
      this.prismaService.$queryRaw<Array<{ week: Date; count: bigint }>>`
        SELECT
          DATE_TRUNC('week', kyc_submitted_at) AS week,
          COUNT(*)::bigint AS count
        FROM caregivers
        WHERE kyc_submitted_at IS NOT NULL
          AND kyc_submitted_at >= ${eightWeeksAgo}
        GROUP BY week
        ORDER BY week ASC
      `,
      // Line 2: KYC approvals per week (by kyc_verified_at)
      this.prismaService.$queryRaw<Array<{ week: Date; approved: bigint }>>`
        SELECT
          DATE_TRUNC('week', kyc_verified_at) AS week,
          COUNT(*)::bigint AS approved
        FROM caregivers
        WHERE kyc_verified_at IS NOT NULL
          AND kyc_verified_at >= ${eightWeeksAgo}
        GROUP BY week
        ORDER BY week ASC
      `,
    ]);

    // Build lookups from DB results
    const submissionMap = new Map<string, number>();
    for (const row of submissionRows) {
      submissionMap.set(row.week.toISOString().slice(0, 10), Number(row.count));
    }
    const approvalMap = new Map<string, number>();
    for (const row of approvalRows) {
      approvalMap.set(row.week.toISOString().slice(0, 10), Number(row.approved));
    }

    // Generate all 8 weeks (fill gaps with 0 for both lines)
    const result: WeeklySubmission[] = [];
    const cursor = new Date(eightWeeksAgo);
    for (let i = 0; i < 8; i++) {
      const key = cursor.toISOString().slice(0, 10); // always UTC date string e.g. "2026-03-23"
      result.push({
        week: key,
        count: submissionMap.get(key) ?? 0,
        approved: approvalMap.get(key) ?? 0,
      });
      cursor.setUTCDate(cursor.getUTCDate() + 7); // advance by exactly 7 days in UTC
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
    // ─── 1. Validate reasons array ────────────────────────────────────────
    if (!input.reasons || input.reasons.length === 0) {
      throw new BadRequestException('ต้องระบุเหตุผลอย่างน้อย 1 ข้อ');
    }

    // ─── 2. Fetch + guard ─────────────────────────────────────────────────
    const existing = await this.prismaService.caregiver.findUnique({
      where: { id: input.caregiverId },
    });

    if (!existing) {
      throw new NotFoundException(`Caregiver "${input.caregiverId}" not found`);
    }

    this.assertReviewable(existing.kycStatus, 'reject');

    // ─── 3. Transaction: update status + INSERT audit record ──────────────
    const reviewReason = input.reasons.map((r) => r.title).join('; ');

    const updated = await this.prismaService.$transaction(async (tx) => {
      const caregiver = await tx.caregiver.update({
        where: { id: input.caregiverId },
        data: {
          kycStatus: 'rejected',
          kycVerifiedAt: null,
          rejection_reasons: input.reasons as unknown as Prisma.InputJsonValue,
        },
      });

      await tx.kycReview.create({
        data: {
          caregiverId: input.caregiverId,
          reviewerId: admin.id,
          action: 'rejected',
          reason: reviewReason,
        },
      });

      return caregiver;
    });

    this.logger.log({
      event: 'admin.kyc.rejected',
      caregiverId: input.caregiverId,
      adminId: admin.id,
      reasonCount: input.reasons.length,
    });

    // ─── 4. Side-effects (fire-and-forget) ───────────────────────────────
    void this.triggerRejectNotify(updated.userId, input.caregiverId, input.reasons);

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
  // USER MANAGEMENT
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * adminUserList — ดึงรายการ users สำหรับ admin
   *
   * Logic:
   * 1. สร้าง where clause จาก role filter + search (OR on displayName/email, mode:'insensitive')
   * 2. Count total → findMany with pagination
   * 3. Map ไป UserSummary[] (isSuspended มาจาก DB โดยตรง)
   *
   * @param input - AdminUserListInput (role?, search?, page?, limit?)
   * @returns AdminUserListPayload
   */
  async adminUserList(input: AdminUserListInput): Promise<AdminUserListPayload> {
    const page = input.page ?? DEFAULT_PAGE;
    const limit = input.limit ?? DEFAULT_LIMIT;
    const offset = (page - 1) * limit;

    // ─── 1. Build where clause ────────────────────────────────────────────
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const where: any = {};

    // Filter by role (ถ้าไม่ส่ง หรือส่ง "all" → ไม่กรอง)
    if (input.role && input.role !== 'all') {
      const roleId = ROLE_FILTER_MAP[input.role];
      if (roleId !== undefined) {
        where.role = roleId;
      }
    }

    // Search by displayName OR email (case-insensitive partial match)
    if (input.search && input.search.trim() !== '') {
      const term = input.search.trim();
      where.OR = [
        { displayName: { contains: term, mode: 'insensitive' } },
        { email: { contains: term, mode: 'insensitive' } },
      ];
    }

    // ─── 2. Count + query ─────────────────────────────────────────────────
    const [total, users] = await Promise.all([
      this.prismaService.user.count({ where }),
      this.prismaService.user.findMany({
        where,
        select: {
          id: true,
          email: true,
          displayName: true,
          role: true,
          isActive: true,
          is_deleted: true,
          createdAt: true,
          scheduled_delete_at: true,
        },
        orderBy: { createdAt: 'desc' },
        skip: offset,
        take: limit,
      }),
    ]);

    const totalPages = total === 0 ? 1 : Math.ceil(total / limit);

    // ─── 3. Batch-fetch caregiver data for role=2 users ───────────────────
    const caregiverUserIds = users
      .filter((u) => u.role === ROLE_ID.CAREGIVER)
      .map((u) => u.id);

    const caregiverMap = new Map<string, { caregiverNumber: string | null; kycStatus: string; fullName: string | null }>();
    if (caregiverUserIds.length > 0) {
      const caregivers = await this.prismaService.caregiver.findMany({
        where: { userId: { in: caregiverUserIds } },
        select: { userId: true, caregiverNumber: true, kycStatus: true, fullName: true },
      });
      for (const c of caregivers) {
        caregiverMap.set(c.userId, { caregiverNumber: c.caregiverNumber, kycStatus: c.kycStatus, fullName: c.fullName });
      }
    }

    // ─── 4. Map to UserSummary ─────────────────────────────────────────────
    const items: UserSummary[] = users.map((u) => {
      const cg = caregiverMap.get(u.id);
      return {
        id: u.id,
        email: u.email,
        displayName: (u.role === ROLE_ID.CAREGIVER && cg?.fullName) ? cg.fullName : (u.displayName ?? undefined),
        role: u.role,
        isActive: u.isActive,
        isSuspended: !u.isActive || u.is_deleted,
        createdAt: u.createdAt,
        scheduledDeleteAt: u.scheduled_delete_at ?? undefined,
        caregiverNumber: cg?.caregiverNumber ?? undefined,
        kycStatus: cg?.kycStatus ?? undefined,
      };
    });

    this.logger.log({
      event: 'admin.user_list.queried',
      filter: { role: input.role, search: !!input.search },
      total,
      page,
      limit,
      returned: items.length,
    });

    return { items, total, page, totalPages };
  }

  /**
   * adminUserDetail — ดึงรายละเอียด user ครบถ้วนสำหรับ admin
   *
   * Logic:
   * 1. Fetch user → NotFoundException ถ้าไม่พบ
   * 2. ถ้า role=2 (caregiver) → fetch caregiver record + kycStatus
   * 3. Compute isSuspended, auditLogCount
   * 4. Return AdminUserDetailPayload
   *
   * @param userId - UUID ของ user
   * @returns AdminUserDetailPayload
   * @throws NotFoundException ถ้าไม่พบ user
   */
  async adminUserDetail(userId: string): Promise<AdminUserDetailPayload> {
    // ─── 1. Fetch user ────────────────────────────────────────────────────
    const raw = await this.prismaService.user.findUnique({
      where: { id: userId },
    });

    if (!raw) {
      throw new NotFoundException(`User "${userId}" not found`);
    }

    const user = this.mapToUser(raw);

    // ─── 2. Fetch caregiver + kycStatus ──────────────────────────────────
    let caregiver: Caregiver | undefined;
    let kycStatus = 'n/a';

    if (raw.role === ROLE_ID.CAREGIVER) {
      const rawCg = await this.prismaService.caregiver.findUnique({
        where: { userId },
      });
      if (rawCg) {
        caregiver = this.mapToCaregiver(rawCg);
        kycStatus = rawCg.kycStatus; // none | pending | verified | rejected
      } else {
        kycStatus = 'none'; // role=caregiver แต่ยังไม่มี caregiver record
      }
    }

    // ─── 3. Count audit logs ($queryRaw — client ยังไม่ regenerate) ─────
    const auditCountResult = await this.prismaService.$queryRaw<
      Array<{ count: bigint }>
    >`SELECT COUNT(*)::bigint AS count FROM admin_audit_logs WHERE target_user_id = ${userId}`;
    const auditLogCount = Number(auditCountResult[0]?.count ?? 0);

    // ─── 4. Compute isSuspended ──────────────────────────────────────────
    const isSuspended = !raw.isActive || raw.is_deleted;

    this.logger.log({
      event: 'admin.user_detail.queried',
      userId,
      role: raw.role,
      kycStatus,
      isSuspended,
      auditLogCount,
    });

    const scheduledDeleteAt = raw.scheduled_delete_at ?? undefined;

    return { user, caregiver, kycStatus, isSuspended, scheduledDeleteAt, auditLogCount };
  }

  /**
   * suspendUser — ระงับ user (set isActive = false)
   *
   * Guards:
   * - admin ลบตัวเองไม่ได้ (self-action guard)
   *
   * Side-effects:
   * - INSERT admin_audit_logs: action = 'suspend_user'
   *
   * @param userId - UUID ของ user ที่จะ suspend
   * @param admin  - admin ที่ทำ action (จาก JWT)
   * @returns User - user ที่ถูก update
   * @throws NotFoundException ถ้าไม่พบ user
   * @throws BadRequestException ถ้า admin พยายาม suspend ตัวเอง
   */
  async suspendUser(userId: string, admin: AuthUser): Promise<User> {
    // ─── Guard: self-action ───────────────────────────────────────────────
    if (userId === admin.id) {
      throw new BadRequestException('ไม่สามารถระงับตัวเองได้');
    }

    // ─── Fetch + validate ────────────────────────────────────────────────
    const existing = await this.prismaService.user.findUnique({
      where: { id: userId },
    });

    if (!existing) {
      throw new NotFoundException(`User "${userId}" not found`);
    }

    if (!existing.isActive) {
      throw new ConflictException('User is already suspended');
    }

    // ─── Transaction: update + audit log ─────────────────────────────────
    const scheduledDeleteAt = new Date();
    scheduledDeleteAt.setDate(scheduledDeleteAt.getDate() + 7);

    const updated = await this.prismaService.$transaction(async (tx) => {
      const user = await tx.user.update({
        where: { id: userId },
        data: { isActive: false, scheduled_delete_at: scheduledDeleteAt },
      });

      // admin_audit_logs — ใช้ $executeRaw เพราะ Prisma client ยังไม่ regenerate
      const details = JSON.stringify({ reason: 'Admin suspended user', scheduledDeleteAt });
      await tx.$executeRaw`
        INSERT INTO admin_audit_logs (id, admin_id, action, target_user_id, details, created_at)
        VALUES (gen_random_uuid(), ${admin.id}, 'suspend_user', ${userId}, ${details}::jsonb, NOW())
      `;

      return user;
    });

    // ─── Supabase Auth ban ────────────────────────────────────────────────
    const supabaseAdmin = this.supabaseService.getAdminClient();
    const { error: supabaseError } = await supabaseAdmin.auth.admin.updateUserById(
      existing.supabaseUid,
      { ban_duration: '876000h' },
    );
    if (supabaseError) {
      this.logger.error(
        `Supabase ban failed for ${existing.supabaseUid}: ${supabaseError.message}`,
      );
    }

    this.logger.log({
      event: 'admin.user.suspended',
      userId,
      adminId: admin.id,
      scheduledDeleteAt,
    });

    return this.mapToUser(updated);
  }

  /**
   * activateUser — ปลดระงับ user (set isActive = true, is_deleted = false)
   *
   * Side-effects:
   * - INSERT admin_audit_logs: action = 'activate_user'
   *
   * @param userId - UUID ของ user ที่จะ activate
   * @param admin  - admin ที่ทำ action (จาก JWT)
   * @returns User - user ที่ถูก update
   * @throws NotFoundException ถ้าไม่พบ user
   */
  async activateUser(userId: string, admin: AuthUser): Promise<User> {
    // ─── Fetch + validate ────────────────────────────────────────────────
    const existing = await this.prismaService.user.findUnique({
      where: { id: userId },
    });

    if (!existing) {
      throw new NotFoundException(`User "${userId}" not found`);
    }

    if (existing.isActive && !existing.is_deleted) {
      throw new ConflictException('User is already active');
    }

    // ─── Transaction: update + audit log ─────────────────────────────────
    const updated = await this.prismaService.$transaction(async (tx) => {
      const user = await tx.user.update({
        where: { id: userId },
        data: { isActive: true, scheduled_delete_at: null, deletion_scheduled_by: null },
      });

      // admin_audit_logs — ใช้ $executeRaw เพราะ Prisma client ยังไม่ regenerate
      const details = JSON.stringify({
        previousState: { isActive: existing.isActive },
      });
      await tx.$executeRaw`
        INSERT INTO admin_audit_logs (id, admin_id, action, target_user_id, details, created_at)
        VALUES (gen_random_uuid(), ${admin.id}, 'activate_user', ${userId}, ${details}::jsonb, NOW())
      `;

      return user;
    });

    // ─── Supabase Auth unban ──────────────────────────────────────────────
    const supabaseAdmin = this.supabaseService.getAdminClient();
    const { error: supabaseError } = await supabaseAdmin.auth.admin.updateUserById(
      existing.supabaseUid,
      { ban_duration: 'none' },
    );
    if (supabaseError) {
      this.logger.error(
        `Supabase unban failed for ${existing.supabaseUid}: ${supabaseError.message}`,
      );
    }

    this.logger.log({
      event: 'admin.user.activated',
      userId,
      adminId: admin.id,
    });

    return this.mapToUser(updated);
  }

  /**
   * changeUserRole — เปลี่ยน role ของ user
   *
   * Guards:
   * - ห้าม admin เปลี่ยน role ตัวเอง
   * - ห้ามเปลี่ยนเป็น admin/super_admin (privilege escalation)
   *   อนุญาตเฉพาะ: patient (1) ↔ caregiver (2)
   *
   * Side-effects:
   * - INSERT admin_audit_logs: action = 'change_role', details = { previousRole, newRole }
   *
   * @param input  - ChangeUserRoleInput (userId, newRole)
   * @param admin  - admin ที่ทำ action (จาก JWT)
   * @returns User - user ที่ถูก update
   * @throws BadRequestException ถ้า admin เปลี่ยน role ตัวเอง หรือ newRole >= 3
   * @throws NotFoundException ถ้าไม่พบ user
   * @throws ConflictException ถ้า role เดิมเท่ากับ newRole
   */
  async changeUserRole(input: ChangeUserRoleInput, admin: AuthUser): Promise<User> {
    const { userId, newRole } = input;

    // ─── Guard: self-action ───────────────────────────────────────────────
    if (userId === admin.id) {
      throw new BadRequestException('ไม่สามารถเปลี่ยน role ตัวเองได้');
    }

    // ─── Guard: privilege escalation ─────────────────────────────────────
    if (newRole >= ROLE_ID.ADMIN) {
      throw new BadRequestException(
        'ไม่สามารถเปลี่ยนเป็น admin หรือ super_admin ได้ (ป้องกัน privilege escalation)',
      );
    }

    // ─── Fetch + validate ────────────────────────────────────────────────
    const existing = await this.prismaService.user.findUnique({
      where: { id: userId },
    });

    if (!existing) {
      throw new NotFoundException(`User "${userId}" not found`);
    }

    if (existing.role === newRole) {
      throw new ConflictException(`User already has role ${newRole}`);
    }

    // ─── Guard: ห้ามเปลี่ยน role ของ admin/super_admin ──────────────────
    if (existing.role >= ROLE_ID.ADMIN) {
      throw new BadRequestException(
        'ไม่สามารถเปลี่ยน role ของ admin หรือ super_admin ได้',
      );
    }

    // ─── Transaction: update + audit log ─────────────────────────────────
    const previousRole = existing.role;
    const updated = await this.prismaService.$transaction(async (tx) => {
      const user = await tx.user.update({
        where: { id: userId },
        data: { role: newRole },
      });

      // admin_audit_logs — ใช้ $executeRaw เพราะ Prisma client ยังไม่ regenerate
      const details = JSON.stringify({ previousRole, newRole });
      await tx.$executeRaw`
        INSERT INTO admin_audit_logs (id, admin_id, action, target_user_id, details, created_at)
        VALUES (gen_random_uuid(), ${admin.id}, 'change_role', ${userId}, ${details}::jsonb, NOW())
      `;

      return user;
    });

    this.logger.log({
      event: 'admin.user.role_changed',
      userId,
      adminId: admin.id,
      previousRole,
      newRole,
    });

    return this.mapToUser(updated);
  }

  // ─────────────────────────────────────────────────────────────────────────
  // ADMIN UPDATE CAREGIVER INFO (KYC detail page)
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * adminUpdateCaregiverInfo — Admin แก้ไข firstName/lastName/idCardNumber/email ของ caregiver
   *
   * Flow:
   * 1. หา caregiver → NotFoundException ถ้าไม่พบ
   * 2. หา linked user (สำหรับ email)
   * 3. Validate email uniqueness ถ้า email เปลี่ยน
   * 4. Build fullName จาก firstName + lastName (split จาก fullName เดิมถ้าส่งมาแค่ฝั่งเดียว)
   * 5. Update caregivers (fullName, idCardNumber)
   * 6. Update users.email + Supabase Auth (ถ้า email เปลี่ยน)
   * 7. Audit log (fire-and-forget)
   * 8. Return AdminUpdateCaregiverInfoPayload { id, firstName, lastName, idCardNumber, email }
   */
  async adminUpdateCaregiverInfo(
    input: AdminUpdateCaregiverInfoInput,
    admin: AuthUser,
  ): Promise<AdminUpdateCaregiverInfoPayload> {
    // ─── 1. หา caregiver ──────────────────────────────────────────────────
    const caregiver = await this.prismaService.caregiver.findUnique({
      where: { id: input.caregiverId },
      include: { user: { select: { id: true, email: true, supabaseUid: true } } },
    });
    if (!caregiver) {
      throw new NotFoundException(`Caregiver "${input.caregiverId}" not found`);
    }

    const linkedUser = caregiver.user;

    // ─── 2. Validate email uniqueness ─────────────────────────────────────
    if (input.email && input.email !== linkedUser.email) {
      const existing = await this.prismaService.user.findUnique({
        where: { email: input.email },
      });
      if (existing) {
        throw new ConflictException('Email already in use');
      }
    }

    // ─── 3. Build fullName ────────────────────────────────────────────────
    let newFullName: string | undefined;
    if (input.firstName !== undefined || input.lastName !== undefined) {
      const parts = (caregiver.fullName ?? '').split(' ');
      const currentFirst = parts[0] ?? '';
      const currentLast = parts.slice(1).join(' ');
      newFullName = `${input.firstName ?? currentFirst} ${input.lastName ?? currentLast}`.trim();
    }

    // ─── 4. Update caregivers ─────────────────────────────────────────────
    const caregiverData: Prisma.CaregiverUpdateInput = {};
    if (newFullName !== undefined)          caregiverData.fullName = newFullName;
    if (input.idCardNumber !== undefined)   caregiverData.idCardNumber = input.idCardNumber;

    const updatedCaregiver = await this.prismaService.caregiver.update({
      where: { id: input.caregiverId },
      data: caregiverData,
    });

    // ─── 5. Update user email + Supabase Auth ─────────────────────────────
    let finalEmail = linkedUser.email;
    if (input.email && input.email !== linkedUser.email) {
      await this.prismaService.user.update({
        where: { id: linkedUser.id },
        data: { email: input.email },
      });
      finalEmail = input.email;

      const supabaseAdmin = this.supabaseService.getAdminClient();
      try {
        await supabaseAdmin.auth.admin.updateUserById(linkedUser.supabaseUid, {
          email: input.email,
        });
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        this.logger.warn(
          `Failed to update Supabase Auth email for user ${linkedUser.id}: ${msg}`,
        );
      }
    }

    // ─── 6. Audit log (fire-and-forget) ──────────────────────────────────
    const changedFields: Record<string, { from: unknown; to: unknown }> = {};
    if (newFullName !== undefined && newFullName !== caregiver.fullName) {
      changedFields.fullName = { from: caregiver.fullName, to: newFullName };
    }
    if (input.idCardNumber !== undefined && input.idCardNumber !== caregiver.idCardNumber) {
      changedFields.idCardNumber = { from: caregiver.idCardNumber, to: input.idCardNumber };
    }
    if (input.email !== undefined && input.email !== linkedUser.email) {
      changedFields.email = { from: linkedUser.email, to: input.email };
    }

    const changedFieldsJson = JSON.stringify(changedFields);
    void this.prismaService.$executeRaw`
      INSERT INTO admin_audit_logs (id, admin_id, action, target_user_id, details, created_at)
      VALUES (gen_random_uuid(), ${admin.id}, 'CAREGIVER_INFO_UPDATED', ${linkedUser.id}, ${changedFieldsJson}::jsonb, NOW())
    `.catch((err: unknown) =>
      this.logSideEffectError('audit CAREGIVER_INFO_UPDATED', input.caregiverId, err),
    );

    this.logger.log({
      event: 'admin.caregiver_info_updated',
      adminId: admin.id,
      caregiverId: input.caregiverId,
      changedFields: Object.keys(changedFields),
    });

    // ─── 7. Build return payload ──────────────────────────────────────────
    const finalFullName = updatedCaregiver.fullName ?? '';
    const nameParts = finalFullName.split(' ');
    return {
      id: updatedCaregiver.id,
      firstName: nameParts[0] ?? '',
      lastName: nameParts.slice(1).join(' '),
      idCardNumber: updatedCaregiver.idCardNumber ?? '',
      email: finalEmail,
    };
  }

  // ─────────────────────────────────────────────────────────────────────────
  // ADMIN EDIT USER (user management)
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * adminEditUser — Admin แก้ไขข้อมูล user ทั่วไป (patient/caregiver)
   *
   * Flow:
   * 1. หา target user → NotFoundException ถ้าไม่พบ
   * 2. Guard: ห้าม edit admin/super_admin ผ่าน mutation นี้ (ใช้ editAdminInfo แทน)
   * 3. Validate email uniqueness ถ้า email เปลี่ยน
   * 4. Build update data เฉพาะ field ที่ส่งมา
   * 5. Update DB
   * 6. Sync Supabase Auth email (ถ้า email เปลี่ยน)
   * 7. Audit log (fire-and-forget)
   * 8. Return updated User
   */
  async adminEditUser(input: AdminEditUserInput, admin: AuthUser): Promise<User> {
    // ─── 1. หา target ─────────────────────────────────────────────────────
    const target = await this.prismaService.user.findUnique({
      where: { id: input.userId },
    });
    if (!target) {
      throw new NotFoundException(`User "${input.userId}" not found`);
    }

    // ─── 2. Guard: ห้าม edit admin/super_admin ────────────────────────────
    if (target.role >= ROLE_ID.ADMIN) {
      throw new BadRequestException(
        'ไม่สามารถแก้ไข admin/super_admin ผ่าน mutation นี้ — ใช้ editAdminInfo แทน',
      );
    }

    // ─── 3. Validate email uniqueness ─────────────────────────────────────
    if (input.email && input.email !== target.email) {
      const existing = await this.prismaService.user.findUnique({
        where: { email: input.email },
      });
      if (existing) {
        throw new ConflictException('Email already in use');
      }
    }

    // ─── 4. Build update data ─────────────────────────────────────────────
    const data: Prisma.UserUpdateInput = {};
    if (input.displayName !== undefined) data.displayName = input.displayName;
    if (input.email !== undefined)       data.email = input.email;
    if (input.phone !== undefined)       data.phone = input.phone;
    if (input.address !== undefined)     data.address = input.address;
    if (input.bio !== undefined)         data.bio = input.bio;

    // ─── 5. Update DB ─────────────────────────────────────────────────────
    const updated = await this.prismaService.user.update({
      where: { id: input.userId },
      data,
    });

    // ─── 6. Sync Supabase Auth email ──────────────────────────────────────
    if (input.email && input.email !== target.email) {
      const supabaseAdmin = this.supabaseService.getAdminClient();
      try {
        await supabaseAdmin.auth.admin.updateUserById(target.supabaseUid, {
          email: input.email,
        });
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        this.logger.warn(`Failed to update Supabase Auth email for ${target.id}: ${msg}`);
      }
    }

    // ─── 7. Audit log (fire-and-forget) ──────────────────────────────────
    const changedFields: Record<string, { from: unknown; to: unknown }> = {};
    if (input.displayName !== undefined && input.displayName !== target.displayName) {
      changedFields.displayName = { from: target.displayName, to: input.displayName };
    }
    if (input.email !== undefined && input.email !== target.email) {
      changedFields.email = { from: target.email, to: input.email };
    }
    if (input.phone !== undefined && input.phone !== target.phone) {
      changedFields.phone = { from: target.phone, to: input.phone };
    }
    if (input.address !== undefined && input.address !== target.address) {
      changedFields.address = { from: target.address, to: input.address };
    }
    if (input.bio !== undefined && input.bio !== target.bio) {
      changedFields.bio = { from: target.bio, to: input.bio };
    }

    const changedFieldsJson = JSON.stringify(changedFields);
    void this.prismaService.$executeRaw`
      INSERT INTO admin_audit_logs (id, admin_id, action, target_user_id, details, created_at)
      VALUES (gen_random_uuid(), ${admin.id}, 'USER_INFO_UPDATED', ${input.userId}, ${changedFieldsJson}::jsonb, NOW())
    `.catch((err: unknown) => this.logSideEffectError('audit USER_INFO_UPDATED', input.userId, err));

    this.logger.log({
      event: 'admin.user_info_updated',
      adminId: admin.id,
      targetUserId: input.userId,
      changedFields: Object.keys(changedFields),
    });

    // ─── 8. Return ────────────────────────────────────────────────────────
    return this.mapToUser(updated);
  }

  // ─────────────────────────────────────────────────────────────────────────
  // ─────────────────────────────────────────────────────────────────────────
  // TOGGLE ADMIN STATUS
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * toggleAdminStatus — Super Admin เปิด/ปิดสถานะ admin account
   *
   * Flow:
   * 1. ห้าม toggle ตัวเอง
   * 2. หา target user — ต้องเป็น admin (role ≥ 3)
   * 3. ปกป้อง Super Admin คนสุดท้าย (ห้าม deactivate ถ้าเหลือคนเดียว)
   * 4. Update is_active ใน DB (activate → clear scheduled_delete_at ด้วย)
   * 5. Supabase Auth ban/unban (two-layer protection กับ DB guard)
   * 6. ส่ง email แจ้ง admin (fire-and-forget)
   * 7. Audit log placeholder
   * 8. Return { user, action }
   *
   * หมายเหตุ Supabase signOut:
   *   auth.admin.signOut() รับ JWT ไม่ใช่ UID → ใช้ updateUserById + ban_duration แทน
   *   ซึ่ง revoke ใหม่ทุก session โดย block ที่ Supabase Auth layer
   *   ร่วมกับ SupabaseAuthGuard ที่เช็ค isActive ทุก request = two-layer protection
   */
  async toggleAdminStatus(
    input: ToggleAdminStatusInput,
    currentUser: AuthUser,
  ): Promise<ToggleAdminStatusPayload> {
    // ─── 1. ห้าม toggle ตัวเอง ────────────────────────────────────────────
    if (input.adminId === currentUser.id) {
      throw new BadRequestException('ไม่สามารถเปลี่ยนสถานะตัวเองได้');
    }

    // ─── 2. หา target user ────────────────────────────────────────────────
    const target = await this.prismaService.user.findUnique({
      where: { id: input.adminId },
    });
    if (!target || target.role < ROLE_ID.ADMIN) {
      throw new NotFoundException('Admin not found');
    }

    // ─── 3. ปกป้อง Super Admin คนสุดท้าย ─────────────────────────────────
    if (!input.isActive && target.role === ROLE_ID.SUPER_ADMIN) {
      const activeSuperAdminCount = await this.prismaService.user.count({
        where: { role: ROLE_ID.SUPER_ADMIN, isActive: true, is_deleted: false },
      });
      if (activeSuperAdminCount <= 1) {
        throw new BadRequestException('ไม่สามารถระงับ Super Admin คนสุดท้ายได้');
      }
    }

    // ─── 4. Update is_active (+ clear scheduled delete เมื่อ activate) ───
    const updated = await this.prismaService.user.update({
      where: { id: input.adminId },
      data: {
        isActive: input.isActive,
        ...(input.isActive && {
          scheduled_delete_at: null,
          deletion_scheduled_by: null,
        }),
      },
    });

    // ─── 5. Supabase Auth ban / unban ─────────────────────────────────────
    // ban_duration: '876000h' ≈ 100 ปี = effectively permanent ban
    // ban_duration: 'none'   = ยกเลิก ban
    const banDuration = input.isActive ? 'none' : '876000h';
    const supabaseAdmin = this.supabaseService.getAdminClient();
    const { error: supabaseError } = await supabaseAdmin.auth.admin.updateUserById(
      target.supabaseUid,
      { ban_duration: banDuration },
    );
    if (supabaseError) {
      // ไม่ throw — DB guard ยังทำงานได้แม้ Supabase ล้มเหลว
      this.logger.error(
        `Supabase ban/unban failed for ${target.supabaseUid}: ${supabaseError.message}`,
      );
    }

    // ─── 6. Send email (fire-and-forget) ──────────────────────────────────
    const emailMethod = input.isActive
      ? this.emailService.sendAdminActivated(updated.email, updated.displayName)
      : this.emailService.sendAdminDeactivated(updated.email, updated.displayName);
    void emailMethod.catch((err: unknown) =>
      this.logSideEffectError('email toggle_admin_status', updated.id, err),
    );

    // ─── 7. Audit log placeholder ─────────────────────────────────────────
    // TODO: replace with admin_audit_logs table insert when table is created (PYG-127)
    this.logger.log({
      event: input.isActive ? 'admin.activated' : 'admin.deactivated',
      changedBy: currentUser.id,
      targetUserId: input.adminId,
      previousStatus: target.isActive,
    });

    // ─── 8. Return ────────────────────────────────────────────────────────
    const action = input.isActive ? 'ADMIN_ACTIVATED' : 'ADMIN_DEACTIVATED';
    return { user: this.mapToUser(updated), action };
  }

  // ─────────────────────────────────────────────────────────────────────────
  // SCHEDULE DELETE + CANCEL
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * scheduleDeleteAdmin — Super Admin กำหนดวันลบบัญชี admin ถาวร (พร้อม grace period)
   *
   * Flow:
   * 1. ห้ามลบตัวเอง
   * 2. หา target (role ≥ 3, ยังไม่ถูกลบ)
   * 3. ปกป้อง Super Admin คนสุดท้าย
   * 4. Validate gracePeriodDays (7/14/30/60)
   * 5. Update DB: isActive=false + scheduled_delete_at + deletion_scheduled_by
   * 6. Ban Supabase Auth (same pattern as toggleAdminStatus)
   * 7. KYC reviews reassign — ข้าม: KycReview.reviewerId เป็น NOT NULL
   *    TODO: migrate reviewer_id เป็น nullable ก่อน implement ส่วนนี้
   * 8. ส่ง email แจ้งวันที่จะถูกลบ (fire-and-forget)
   * 9. Audit log placeholder
   */
  async scheduleDeleteAdmin(
    input: ScheduleDeleteAdminInput,
    currentUser: AuthUser,
  ): Promise<ScheduleDeleteAdminPayload> {
    const gracePeriodDays = input.gracePeriodDays ?? 7;

    // ─── 1. ห้ามลบตัวเอง ──────────────────────────────────────────────────
    if (input.adminId === currentUser.id) {
      throw new BadRequestException('ไม่สามารถกำหนดลบตัวเองได้');
    }

    // ─── 2. หา target + validate ──────────────────────────────────────────
    const target = await this.prismaService.user.findUnique({
      where: { id: input.adminId },
    });
    if (!target || target.role < ROLE_ID.ADMIN) {
      throw new NotFoundException('Admin not found');
    }
    if (target.is_deleted) {
      throw new ConflictException('Admin already deleted');
    }

    // ─── 3. ปกป้อง Super Admin คนสุดท้าย ─────────────────────────────────
    if (target.role === ROLE_ID.SUPER_ADMIN) {
      const activeSuperAdminCount = await this.prismaService.user.count({
        where: { role: ROLE_ID.SUPER_ADMIN, isActive: true, is_deleted: false },
      });
      if (activeSuperAdminCount <= 1) {
        throw new BadRequestException('ไม่สามารถกำหนดลบ Super Admin คนสุดท้ายได้');
      }
    }

    // ─── 4. Validate grace period ─────────────────────────────────────────
    const ALLOWED_PERIODS = [7, 14, 30, 60];
    if (!ALLOWED_PERIODS.includes(gracePeriodDays)) {
      throw new BadRequestException('Grace period must be 7, 14, 30, or 60 days');
    }

    // ─── 5. Compute scheduled date + update DB ────────────────────────────
    const scheduledDeleteAt = new Date();
    scheduledDeleteAt.setDate(scheduledDeleteAt.getDate() + gracePeriodDays);

    const updated = await this.prismaService.user.update({
      where: { id: input.adminId },
      data: {
        isActive: false,
        scheduled_delete_at: scheduledDeleteAt,
        deletion_scheduled_by: currentUser.id,
      },
    });

    // ─── 6. Supabase ban ──────────────────────────────────────────────────
    const supabaseAdmin = this.supabaseService.getAdminClient();
    const { error: supabaseError } = await supabaseAdmin.auth.admin.updateUserById(
      target.supabaseUid,
      { ban_duration: '876000h' },
    );
    if (supabaseError) {
      this.logger.error(
        `Supabase ban failed for ${target.supabaseUid}: ${supabaseError.message}`,
      );
    }

    // ─── 8. Email (fire-and-forget) ───────────────────────────────────────
    void this.emailService
      .sendAdminScheduleDelete(updated.email, updated.displayName, scheduledDeleteAt, gracePeriodDays)
      .catch((err: unknown) => this.logSideEffectError('email schedule_delete', updated.id, err));

    // ─── 9. Audit log placeholder ─────────────────────────────────────────
    // TODO: replace with admin_audit_logs insert when table is created (PYG-127)
    this.logger.log({
      event: 'admin.delete_scheduled',
      scheduledBy: currentUser.id,
      targetUserId: input.adminId,
      gracePeriodDays,
      scheduledDeleteAt: scheduledDeleteAt.toISOString(),
    });

    return { user: this.mapToUser(updated), scheduledDeleteAt, gracePeriodDays };
  }

  /**
   * cancelScheduledDelete — ยกเลิกการกำหนดลบบัญชี + reactivate
   *
   * Flow:
   * 1. หา target (role ≥ 3, มี scheduled_delete_at, ยังไม่ถูกลบ)
   * 2. Reactivate + clear scheduled_delete_at + deletion_scheduled_by
   * 3. Unban Supabase Auth
   * 4. ส่ง email แจ้ง cancel (fire-and-forget)
   * 5. Audit log placeholder
   */
  async cancelScheduledDelete(
    input: CancelScheduledDeleteInput,
    currentUser: AuthUser,
  ): Promise<CancelScheduledDeletePayload> {
    // ─── 1. หา target + validate ──────────────────────────────────────────
    const target = await this.prismaService.user.findUnique({
      where: { id: input.adminId },
    });
    if (!target || target.role < ROLE_ID.ADMIN) {
      throw new NotFoundException('Admin not found');
    }
    if (!target.scheduled_delete_at) {
      throw new BadRequestException('Admin does not have a scheduled deletion');
    }
    if (target.is_deleted) {
      throw new ConflictException('Admin already deleted, cannot cancel');
    }

    // ─── 2. Reactivate + clear schedule ──────────────────────────────────
    const updated = await this.prismaService.user.update({
      where: { id: input.adminId },
      data: {
        isActive: true,
        scheduled_delete_at: null,
        deletion_scheduled_by: null,
      },
    });

    // ─── 3. Supabase unban ────────────────────────────────────────────────
    const supabaseAdmin = this.supabaseService.getAdminClient();
    const { error: supabaseError } = await supabaseAdmin.auth.admin.updateUserById(
      target.supabaseUid,
      { ban_duration: 'none' },
    );
    if (supabaseError) {
      this.logger.error(
        `Supabase unban failed for ${target.supabaseUid}: ${supabaseError.message}`,
      );
    }

    // ─── 4. Email (fire-and-forget) ───────────────────────────────────────
    void this.emailService
      .sendAdminCancelDelete(updated.email, updated.displayName)
      .catch((err: unknown) => this.logSideEffectError('email cancel_delete', updated.id, err));

    // ─── 5. Audit log placeholder ─────────────────────────────────────────
    // TODO: replace with admin_audit_logs insert when table is created (PYG-127)
    this.logger.log({
      event: 'admin.delete_cancelled',
      cancelledBy: currentUser.id,
      targetUserId: input.adminId,
      previousScheduledDeleteAt: target.scheduled_delete_at,
    });

    return { user: this.mapToUser(updated), reactivated: true };
  }

  // ─────────────────────────────────────────────────────────────────────────
  // EDIT ADMIN INFO (PYG-160)
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * editAdminInfo — Super Admin แก้ไขข้อมูล admin (ชื่อ, email, role)
   *
   * Flow:
   * 1. หา target (role ≥ 3, ยังไม่ถูกลบ)
   * 2. Validate role value ถ้าส่งมา (ต้องเป็น 3 หรือ 4)
   * 3. ปกป้อง Super Admin คนสุดท้าย (ถ้าลด 4→3)
   * 4. ตรวจ email uniqueness ถ้า email เปลี่ยน
   * 5. Build displayName จาก firstName + lastName
   * 6. Update DB
   * 7. Sync Supabase Auth email (ถ้า email เปลี่ยน)
   * 8. Audit log พร้อม changed fields (from/to)
   * 9. Return { user }
   */
  async editAdminInfo(
    input: EditAdminInfoInput,
    currentUser: AuthUser,
  ): Promise<EditAdminInfoPayload> {
    // ─── 1. หา target ─────────────────────────────────────────────────────
    const target = await this.prismaService.user.findUnique({
      where: { id: input.adminId },
    });
    if (!target || target.role < ROLE_ID.ADMIN) {
      throw new NotFoundException('Admin not found');
    }
    if (target.is_deleted) {
      throw new ConflictException('Cannot edit deleted admin');
    }

    // ─── 2. Validate role value ───────────────────────────────────────────
    if (input.role !== undefined && input.role !== ROLE_ID.ADMIN && input.role !== ROLE_ID.SUPER_ADMIN) {
      throw new BadRequestException('Role must be 3 (admin) or 4 (super_admin)');
    }

    // ─── 3. ปกป้อง Super Admin คนสุดท้าย ─────────────────────────────────
    if (input.role === ROLE_ID.ADMIN && target.role === ROLE_ID.SUPER_ADMIN) {
      const activeSuperAdminCount = await this.prismaService.user.count({
        where: { role: ROLE_ID.SUPER_ADMIN, isActive: true, is_deleted: false },
      });
      if (activeSuperAdminCount <= 1) {
        throw new BadRequestException('ไม่สามารถลดสิทธิ์ Super Admin คนสุดท้ายได้');
      }
    }

    // ─── 4. Validate email uniqueness ─────────────────────────────────────
    if (input.email && input.email !== target.email) {
      const existing = await this.prismaService.user.findUnique({
        where: { email: input.email },
      });
      if (existing) {
        throw new ConflictException('Email already in use');
      }
    }

    // ─── 5. Build displayName ─────────────────────────────────────────────
    let newDisplayName: string | undefined;
    if (input.firstName !== undefined || input.lastName !== undefined) {
      const currentFirst = target.displayName?.split(' ')[0] ?? '';
      const currentLast = target.displayName?.split(' ').slice(1).join(' ') ?? '';
      newDisplayName = `${input.firstName ?? currentFirst} ${input.lastName ?? currentLast}`.trim();
    }

    // ─── 6. Update DB ─────────────────────────────────────────────────────
    const updated = await this.prismaService.user.update({
      where: { id: input.adminId },
      data: {
        ...(newDisplayName !== undefined && { displayName: newDisplayName }),
        ...(input.email && { email: input.email }),
        ...(input.role !== undefined && { role: input.role }),
      },
    });

    // ─── 7. Sync Supabase Auth email ──────────────────────────────────────
    if (input.email && input.email !== target.email) {
      const supabaseAdmin = this.supabaseService.getAdminClient();
      try {
        await supabaseAdmin.auth.admin.updateUserById(target.supabaseUid, {
          email: input.email,
        });
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        this.logger.warn(`Failed to update Supabase Auth email for ${target.id}: ${msg}`);
      }
    }

    // ─── 8. Audit log — record which fields changed ───────────────────────
    const changedFields: Record<string, { from: unknown; to: unknown }> = {};
    if (newDisplayName !== undefined && newDisplayName !== target.displayName) {
      changedFields.displayName = { from: target.displayName, to: newDisplayName };
    }
    if (input.email && input.email !== target.email) {
      changedFields.email = { from: target.email, to: input.email };
    }
    if (input.role !== undefined && input.role !== target.role) {
      changedFields.role = { from: target.role, to: input.role };
    }

    const changedFieldsJson = JSON.stringify(changedFields);
    void this.prismaService.$executeRaw`
      INSERT INTO admin_audit_logs (id, admin_id, action, target_user_id, details, created_at)
      VALUES (gen_random_uuid(), ${currentUser.id}, 'ADMIN_INFO_UPDATED', ${input.adminId}, ${changedFieldsJson}::jsonb, NOW())
    `.catch((err: unknown) => this.logSideEffectError('audit ADMIN_INFO_UPDATED', input.adminId, err));

    this.logger.log({
      event: 'admin.info_updated',
      changedBy: currentUser.id,
      targetUserId: input.adminId,
      changedFields: Object.keys(changedFields),
    });

    // ─── 9. Return ────────────────────────────────────────────────────────
    return { user: this.mapToUser(updated) };
  }

  // ─────────────────────────────────────────────────────────────────────────
  // FIELD LOCK (PYG-145)
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * camelCase field names ที่ lock ได้ — ต้องตรงกับ GraphQL input field names
   * ที่ FieldLockGuard จะเห็นใน Object.keys(input) ขณะ runtime
   */
  private readonly LOCKABLE_FIELDS: Readonly<Record<EntityTypeEnum, readonly string[]>> = {
    [EntityTypeEnum.CAREGIVER_PROFILE]: ['firstName', 'lastName', 'idCardNumber', 'email', 'bio', 'hourlyRate', 'skills', 'experienceYears', 'phone', 'address'],
    [EntityTypeEnum.USER]: ['displayName', 'phone', 'email', 'bio', 'address'],
  };

  /**
   * toggleFieldLock — lock หรือ unlock field ของ caregiver / user
   *
   * Flow (lock):
   *   1. Validate fieldName อยู่ใน whitelist
   *   2. Validate entity มีอยู่จริง
   *   3. Check ว่าไม่ได้ lock ซ้ำ (active lock = unlocked_at IS NULL)
   *   4. Upsert field_locks (รองรับ re-lock หลัง unlock)
   *   5. Audit log (fire-and-forget)
   *
   * Flow (unlock):
   *   1-2. เหมือนด้านบน
   *   3. Check ว่ามี active lock อยู่จริง
   *   4. Soft-unlock: UPDATE unlocked_at = now(), unlocked_by = admin
   *   5. Audit log (fire-and-forget)
   */
  async toggleFieldLock(input: ToggleFieldLockInput, admin: AuthUser): Promise<FieldLockResult> {
    const { entityType, entityId, fieldName, lock } = input;

    // ─── 1. Validate fieldName ────────────────────────────────────────────
    const allowed = this.LOCKABLE_FIELDS[entityType];
    if (!allowed.includes(fieldName)) {
      throw new BadRequestException(
        `Field "${fieldName}" cannot be locked for ${entityType}. Allowed: ${allowed.join(', ')}`,
      );
    }

    // ─── 2. Validate entity exists ────────────────────────────────────────
    if (entityType === EntityTypeEnum.CAREGIVER_PROFILE) {
      const caregiver = await this.prismaService.caregiver.findUnique({ where: { id: entityId } });
      if (!caregiver) throw new NotFoundException(`Caregiver "${entityId}" not found`);
    } else {
      const user = await this.prismaService.user.findUnique({ where: { id: entityId } });
      if (!user) throw new NotFoundException(`User "${entityId}" not found`);
    }

    if (lock) {
      // ─── 3. Duplicate lock check ───────────────────────────────────────
      const existing = await this.prismaService.field_locks.findFirst({
        where: { entity_type: entityType, entity_id: entityId, field_name: fieldName, unlocked_at: null },
      });
      if (existing) throw new ConflictException(`Field "${fieldName}" is already locked`);

      // ─── 4. Upsert (create or re-lock after previous unlock) ──────────
      const result = await this.prismaService.field_locks.upsert({
        where: {
          entity_type_entity_id_field_name: { entity_type: entityType, entity_id: entityId, field_name: fieldName },
        },
        create: { entity_type: entityType, entity_id: entityId, field_name: fieldName, locked_by: admin.id },
        update: { locked_by: admin.id, locked_at: new Date(), unlocked_at: null, unlocked_by: null },
        include: { users_field_locks_locked_byTousers: { select: { displayName: true } } },
      });

      // ─── 5. Audit log (fire-and-forget) ───────────────────────────────
      void this.auditFieldLock('FIELD_LOCK', admin.id, entityId, { entityType, entityId, fieldName })
        .catch((err: unknown) => this.logSideEffectError('audit FIELD_LOCK', entityId, err));

      return {
        success: true,
        fieldName,
        locked: true,
        lockedBy: result.users_field_locks_locked_byTousers?.displayName ?? undefined,
        lockedAt: result.locked_at,
      };
    } else {
      // ─── 3. Upsert unlock — handles no-record, active lock, and already-unlocked cases ─
      // "No record" means the field is locked by default, so we create a record that is
      // immediately unlocked (locked_at = unlocked_at = now) so the admin can edit it.
      await this.prismaService.field_locks.upsert({
        where: {
          entity_type_entity_id_field_name: { entity_type: entityType, entity_id: entityId, field_name: fieldName },
        },
        create: {
          entity_type: entityType,
          entity_id: entityId,
          field_name: fieldName,
          locked_by: admin.id,
          locked_at: new Date(),
          unlocked_at: new Date(),
          unlocked_by: admin.id,
        },
        update: { unlocked_at: new Date(), unlocked_by: admin.id },
      });

      // ─── 4. Audit log (fire-and-forget) ───────────────────────────────
      void this.auditFieldLock('FIELD_UNLOCK', admin.id, entityId, { entityType, entityId, fieldName })
        .catch((err: unknown) => this.logSideEffectError('audit FIELD_UNLOCK', entityId, err));

      return { success: true, fieldName, locked: false };
    }
  }

  /**
   * getLockedFields — ดึง active locks ทั้งหมดของ entity
   * (active = unlocked_at IS NULL)
   */
  async getLockedFields(entityType: string, entityId: string): Promise<LockedField[]> {
    const locks = await this.prismaService.field_locks.findMany({
      where: { entity_type: entityType, entity_id: entityId, unlocked_at: null },
      include: { users_field_locks_locked_byTousers: { select: { displayName: true } } },
    });

    return locks.map((lock) => ({
      fieldName: lock.field_name,
      locked: true,
      lockedBy: lock.users_field_locks_locked_byTousers?.displayName ?? 'ผู้ดูแลระบบ',
      lockedAt: lock.locked_at,
    }));
  }

  private auditFieldLock(
    action: 'FIELD_LOCK' | 'FIELD_UNLOCK',
    adminId: string,
    targetEntityId: string,
    details: object,
  ): Promise<unknown> {
    const detailsJson = JSON.stringify(details);
    return this.prismaService.$executeRaw`
      INSERT INTO admin_audit_logs (id, admin_id, action, target_user_id, details, created_at)
      VALUES (gen_random_uuid(), ${adminId}, ${action}, ${targetEntityId}, ${detailsJson}::jsonb, NOW())
    `;
  }

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
    reasons: RejectionReasonItem[],
  ): Promise<void> {
    const reasonSummary = reasons.map((r) => r.title).join(', ');

    try {
      await this.notificationService.create(
        userId,
        NotificationType.kyc_rejected,
        'การยืนยันตัวตนไม่ผ่าน',
        `เหตุผล: ${reasonSummary}`,
        { caregiverId, linkPath: '/kyc/resubmit' },
      );
    } catch (err) {
      this.logSideEffectError('notification kyc_rejected', userId, err);
    }

    try {
      await this.emailService.sendKycRejected(userId, reasonSummary);
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
    is_deleted: boolean;
    emailPreferences: boolean;
    must_change_password: boolean;
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
      isSuspended: !u.isActive || u.is_deleted,
      emailPreferences: u.emailPreferences,
      mustChangePassword: u.must_change_password,
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
    languages: string[];
    resubmitCount: number;
    createdAt: Date;
    updatedAt: Date;
    user?: { email: string } | null;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    rejection_reasons?: any;
  }): Caregiver {
    return {
      id: c.id,
      userId: c.userId,
      email: c.user?.email ?? undefined,
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
      languages: c.languages || [],
      resubmitCount: c.resubmitCount,
      createdAt: c.createdAt,
      updatedAt: c.updatedAt,
      rejectionReasons: Array.isArray(c.rejection_reasons)
        ? c.rejection_reasons
        : undefined,
    };
  }
}
