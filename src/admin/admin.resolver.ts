/**
 * AdminResolver — GraphQL Resolver สำหรับ admin operations
 *
 * Queries:
 * - adminKycList(input: AdminKycListInput!): AdminKycListPayload
 *   → ดูรายการ KYC submissions ทั้งหมด (เฉพาะ admin เท่านั้น)
 * - adminKycDetail(caregiverId: ID!): AdminKycDetailPayload
 *   → ดูรายละเอียด KYC ครบถ้วนของ caregiver แต่ละคน พร้อม documents + review history
 * - adminDashboard: AdminDashboardPayload
 *   → สรุปภาพรวม: stats, weekly submissions, avg review time, recent activity
 *
 * Mutations:
 * - approveKyc(caregiverId: ID!): Caregiver
 *   → อนุมัติ KYC: set verified + INSERT audit + notify
 * - rejectKyc(input: RejectKycInput!): Caregiver
 *   → ปฏิเสธ KYC: set rejected + INSERT audit (พร้อม reason) + notify
 *
 * Guards (ทำงานตามลำดับ):
 * 1. SupabaseAuthGuard — ตรวจ JWT + inject req.user
 * 2. RolesGuard        — ตรวจว่า user.role === 3 (ADMIN)
 */
import { Resolver, Query, Mutation, Args, ID } from '@nestjs/graphql';
import { UseGuards } from '@nestjs/common';
import { AdminService } from './admin.service';
import { AdminKycListInput } from './dto/admin-kyc-list.input';
import { AdminKycListPayload } from './dto/admin-kyc-list.payload';
import { AdminKycDetailPayload } from './dto/admin-kyc-detail.payload';
import { AdminDashboardPayload } from './dto/admin-dashboard.payload';
import { RejectKycInput } from './dto/reject-kyc.input';
import { InviteAdminInput } from './dto/invite-admin.input';
import { InviteAdminPayload } from './dto/invite-admin.payload';
import { Caregiver } from '../identity/kyc/entities/caregiver.entity';
import { SupabaseAuthGuard } from '../common/guards/supabase-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { ROLE_ID } from '../common/constants/roles.constant';
import { CurrentUser, AuthUser } from '../common/decorators/current-user.decorator';

@Resolver()
@UseGuards(SupabaseAuthGuard, RolesGuard)
@Roles(ROLE_ID.ADMIN)
export class AdminResolver {
  constructor(private readonly adminService: AdminService) { }

  /**
   * adminKycList — ดึงรายการ KYC submissions พร้อม filter/search/pagination
   *
   * @example
   * query {
   *   adminKycList(input: { status: pending, page: 1, limit: 20 }) {
   *     items { id fullName kycStatus submittedAt documentCount }
   *     total
   *     page
   *     totalPages
   *   }
   * }
   *
   * @param input - AdminKycListInput (status, search, page, limit)
   * @returns AdminKycListPayload (items, total, page, totalPages)
   */
  @Query(() => AdminKycListPayload, {
    description:
      'Admin only: Get paginated list of caregiver KYC submissions. ' +
      'Filter by status, search by name. Pending items shown first.',
  })
  async adminKycList(
    @Args('input') input: AdminKycListInput,
  ): Promise<AdminKycListPayload> {
    return this.adminService.adminKycList(input);
  }

  /**
   * adminKycDetail — ดึงรายละเอียด KYC ครบถ้วนของ caregiver แต่ละคน
   *
   * @example
   * query {
   *   adminKycDetail(caregiverId: "uuid-here") {
   *     caregiver { fullName phone bio skills experienceYears idCardNumber }
   *     documents { id docType signedUrl fileName uploadedAt }
   *     reviews { id action reason reviewedBy reviewedAt }
   *     resubmitCount
   *   }
   * }
   *
   * @param caregiverId - UUID ของ caregiver
   * @returns AdminKycDetailPayload
   */
  @Query(() => AdminKycDetailPayload, {
    description:
      'Admin only: Get full KYC detail for a single caregiver. ' +
      'Includes profile, documents with signed URLs (1hr), and review history.',
  })
  async adminKycDetail(
    @Args('caregiverId', { type: () => ID }) caregiverId: string,
  ): Promise<AdminKycDetailPayload> {
    return this.adminService.adminKycDetail(caregiverId);
  }

  /**
   * adminDashboard — ดึงข้อมูลสรุปภาพรวมระบบ KYC สำหรับ admin dashboard
   *
   * @example
   * query {
   *   adminDashboard {
   *     summary { totalUsers totalCaregivers pendingKyc verifiedKyc rejectedKyc }
   *     weeklySubmissions { week count }
   *     avgReviewTimeHours
   *     recentActivity { type caregiverName action timestamp }
   *   }
   * }
   */
  @Query(() => AdminDashboardPayload, {
    description:
      'Admin only: Dashboard overview with KYC stats, weekly submission trends, ' +
      'average review time, and recent admin activity.',
  })
  async adminDashboard(): Promise<AdminDashboardPayload> {
    return this.adminService.adminDashboard();
  }

  // ─────────────────────────────────────────────────────────────────────────
  // KYC MUTATIONS
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * approveKyc — admin อนุมัติ KYC submission
   *
   * Guard: kycStatus ต้องเป็น 'pending'
   * - 'none'     → 400 BadRequest
   * - 'verified' → 409 Conflict
   * - 'rejected' → 409 Conflict
   *
   * @example
   * mutation {
   *   approveKyc(caregiverId: "uuid-here") {
   *     id fullName kycStatus kycVerifiedAt
   *   }
   * }
   *
   * @param caregiverId - UUID ของ caregiver ที่ต้องการ approve
   * @param admin       - admin user ที่ทำการ approve (จาก JWT)
   */
  @Mutation(() => Caregiver, {
    description:
      'Admin only: Approve a caregiver KYC submission. ' +
      'Sets kycStatus = "verified", records audit log, sends notification + email. ' +
      'Requires kycStatus = "pending".',
  })
  async approveKyc(
    @Args('caregiverId', { type: () => ID, description: 'UUID of the caregiver to approve' })
    caregiverId: string,
    @CurrentUser() admin: AuthUser,
  ): Promise<Caregiver> {
    return this.adminService.approveKyc(caregiverId, admin);
  }

  /**
   * rejectKyc — admin ปฏิเสธ KYC submission
   *
   * Guard: kycStatus ต้องเป็น 'pending'
   * - 'none'     → 400 BadRequest
   * - 'verified' → 409 Conflict
   * - 'rejected' → 409 Conflict
   *
   * @example
   * mutation {
   *   rejectKyc(input: { caregiverId: "uuid-here", reason: "เอกสารไม่ครบถ้วน กรุณาอัปโหลดใหม่" }) {
   *     id fullName kycStatus
   *   }
   * }
   *
   * @param input - RejectKycInput (caregiverId + reason min 10 chars)
   * @param admin - admin user ที่ทำการ reject (จาก JWT)
   */
  @Mutation(() => Caregiver, {
    description:
      'Admin only: Reject a caregiver KYC submission with a reason. ' +
      'Sets kycStatus = "rejected", records audit log with reason, sends notification + email. ' +
      'Requires kycStatus = "pending". Reason must be at least 10 characters.',
  })
  async rejectKyc(
    @Args('input') input: RejectKycInput,
    @CurrentUser() admin: AuthUser,
  ): Promise<Caregiver> {
    return this.adminService.rejectKyc(input, admin);
  }

  // ─────────────────────────────────────────────────────────────────────────
  // INVITE ADMIN
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * inviteAdmin — Super Admin เชิญ Admin/Super Admin ใหม่
   *
   * Guard: SUPER_ADMIN (role=4) เท่านั้น — @Roles ที่ method level override class level
   *
   * @example
   * mutation {
   *   inviteAdmin(input: { email: "new@payung.app", firstName: "สมชาย", lastName: "ใจดี", role: 3 }) {
   *     user { id email displayName role }
   *     tempPasswordSent
   *   }
   * }
   */
  @Mutation(() => InviteAdminPayload, {
    description:
      'Super Admin only: Invite a new Admin (role=3) or Super Admin (role=4). ' +
      'Creates Supabase auth user + DB record, sends invitation email with temp password.',
  })
  @Roles(ROLE_ID.SUPER_ADMIN)
  async inviteAdmin(
    @Args('input') input: InviteAdminInput,
    @CurrentUser() admin: AuthUser,
  ): Promise<InviteAdminPayload> {
    return this.adminService.inviteAdmin(input, admin);
  }
}
