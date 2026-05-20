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
import { ToggleAdminStatusInput } from './dto/toggle-admin-status.input';
import { ToggleAdminStatusPayload } from './dto/toggle-admin-status.payload';
import { ScheduleDeleteAdminInput } from './dto/schedule-delete-admin.input';
import { ScheduleDeleteAdminPayload } from './dto/schedule-delete-admin.payload';
import { CancelScheduledDeleteInput } from './dto/cancel-scheduled-delete.input';
import { CancelScheduledDeletePayload } from './dto/cancel-scheduled-delete.payload';
import { AdminUserListInput } from './dto/admin-user-list.input';
import { AdminUserListPayload } from './dto/admin-user-list.payload';
import { AdminUserDetailPayload } from './dto/admin-user-detail.payload';
import { ChangeUserRoleInput } from './dto/change-user-role.input';
import { EditAdminInfoInput } from './dto/edit-admin-info.input';
import { EditAdminInfoPayload } from './dto/edit-admin-info.payload';
import { AdminEditUserInput } from './dto/admin-edit-user.input';
import { AdminUpdateCaregiverInfoInput } from './dto/admin-update-caregiver-info.input';
import { AdminUpdateCaregiverInfoPayload } from './dto/admin-update-caregiver-info.payload';
import { ToggleFieldLockInput, EntityTypeEnum } from './dto/toggle-field-lock.input';
import { FieldLockResult, LockedField } from './dto/field-lock.payload';
import { Caregiver } from '../identity/kyc/entities/caregiver.entity';
import { User } from '../identity/auth/entities/user.entity';
import { SupabaseAuthGuard } from '../common/guards/supabase-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { ROLE_ID } from '../common/constants/roles.constant';
import { CurrentUser, AuthUser } from '../common/decorators/current-user.decorator';

@Resolver()
@UseGuards(SupabaseAuthGuard, RolesGuard)
@Roles(ROLE_ID.ADMIN, ROLE_ID.SUPER_ADMIN)
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
   *   rejectKyc(input: {
   *     caregiverId: "uuid-here"
   *     reasons: [
   *       { title: "เอกสารไม่ชัดเจน", detail: "กรุณาถ่ายรูปให้ชัดขึ้น", documentType: "id_card_photo" }
   *       { title: "ข้อมูลไม่ตรงกัน" }
   *     ]
   *   }) {
   *     id fullName kycStatus
   *     rejectionReasons { title detail documentType }
   *   }
   * }
   *
   * @param input - RejectKycInput (caregiverId + reasons[])
   * @param admin - admin user ที่ทำการ reject (จาก JWT)
   */
  @Mutation(() => Caregiver, {
    description:
      'Admin only: Reject a caregiver KYC submission with one or more structured reasons. ' +
      'Stores reasons as JSONB, sets kycStatus = "rejected", records audit log, sends notification + email. ' +
      'Requires kycStatus = "pending". At least one reason with a title is required.',
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

  // ─────────────────────────────────────────────────────────────────────────
  // USER MANAGEMENT QUERIES
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * adminUserList — ดึงรายการ users พร้อม filter/search/pagination
   *
   * @example
   * query {
   *   adminUserList(input: { role: caregiver, search: "สมชาย", page: 1, limit: 20 }) {
   *     items { id email displayName role isActive isSuspended createdAt }
   *     total
   *     page
   *     totalPages
   *   }
   * }
   */
  @Query(() => AdminUserListPayload, {
    description:
      'Admin only: Get paginated list of users. ' +
      'Filter by role, search by name/email. Newest users first.',
  })
  async adminUserList(
    @Args('input') input: AdminUserListInput,
  ): Promise<AdminUserListPayload> {
    return this.adminService.adminUserList(input);
  }

  /**
   * adminUserDetail — ดึงรายละเอียด user ครบถ้วน
   *
   * @example
   * query {
   *   adminUserDetail(userId: "uuid-here") {
   *     user { id email displayName role isActive }
   *     caregiver { fullName kycStatus }
   *     kycStatus
   *     isSuspended
   *     auditLogCount
   *   }
   * }
   */
  @Query(() => AdminUserDetailPayload, {
    description:
      'Admin only: Get full user detail including caregiver info, KYC status, ' +
      'suspension state, and audit log count.',
  })
  async adminUserDetail(
    @Args('userId', { type: () => ID, description: 'UUID of the user' })
    userId: string,
  ): Promise<AdminUserDetailPayload> {
    return this.adminService.adminUserDetail(userId);
  }

  // ─────────────────────────────────────────────────────────────────────────
  // USER MANAGEMENT MUTATIONS
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * suspendUser — ระงับ user
   *
   * Guard: admin ลบตัวเองไม่ได้
   *
   * @example
   * mutation {
   *   suspendUser(userId: "uuid-here") {
   *     id email isActive
   *   }
   * }
   */
  @Mutation(() => User, {
    description:
      'Admin only: Suspend a user (set isActive = false). ' +
      'Cannot suspend yourself. Records audit log.',
  })
  async suspendUser(
    @Args('userId', { type: () => ID, description: 'UUID of the user to suspend' })
    userId: string,
    @CurrentUser() admin: AuthUser,
  ): Promise<User> {
    return this.adminService.suspendUser(userId, admin);
  }

  /**
   * activateUser — ปลดระงับ user
   *
   * @example
   * mutation {
   *   activateUser(userId: "uuid-here") {
   *     id email isActive
   *   }
   * }
   */
  @Mutation(() => User, {
    description:
      'Admin only: Activate a suspended user (set isActive = true, is_deleted = false). ' +
      'Records audit log.',
  })
  async activateUser(
    @Args('userId', { type: () => ID, description: 'UUID of the user to activate' })
    userId: string,
    @CurrentUser() admin: AuthUser,
  ): Promise<User> {
    return this.adminService.activateUser(userId, admin);
  }

  /**
   * changeUserRole — เปลี่ยน role ของ user
   *
   * Guards:
   * - ห้ามเปลี่ยน role ตัวเอง
   * - ห้ามเปลี่ยนเป็น admin/super_admin (privilege escalation)
   * - อนุญาตเฉพาะ patient (1) ↔ caregiver (2)
   *
   * @example
   * mutation {
   *   changeUserRole(input: { userId: "uuid-here", newRole: 2 }) {
   *     id email role
   *   }
   * }
   */
  @Mutation(() => User, {
    description:
      'Admin only: Change a user role. Only patient (1) ↔ caregiver (2) allowed. ' +
      'Cannot change own role or escalate to admin/super_admin. Records audit log.',
  })
  async changeUserRole(
    @Args('input') input: ChangeUserRoleInput,
    @CurrentUser() admin: AuthUser,
  ): Promise<User> {
    return this.adminService.changeUserRole(input, admin);
  }

  // ─────────────────────────────────────────────────────────────────────────
  // TOGGLE ADMIN STATUS
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * toggleAdminStatus — Super Admin เปิด/ปิดสถานะ admin account
   *
   * Guard: SUPER_ADMIN (role=4) เท่านั้น — override class-level @Roles
   * - Deactivate → sets is_active=false + ban Supabase Auth + ส่ง email
   * - Activate   → sets is_active=true + clears scheduled_delete_at + unban + ส่ง email
   *
   * @example
   * mutation {
   *   toggleAdminStatus(input: { adminId: "uuid", isActive: false }) {
   *     user { id email isActive }
   *     action
   *   }
   * }
   */
  // ─────────────────────────────────────────────────────────────────────────
  // SCHEDULE DELETE + CANCEL
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * scheduleDeleteAdmin — กำหนดวันลบบัญชี admin ถาวรพร้อม grace period
   *
   * @example
   * mutation {
   *   scheduleDeleteAdmin(input: { adminId: "uuid", gracePeriodDays: 30 }) {
   *     user { id email isActive }
   *     scheduledDeleteAt
   *     gracePeriodDays
   *   }
   * }
   */
  @Mutation(() => ScheduleDeleteAdminPayload, {
    description:
      'Super Admin only: Schedule permanent deletion of an admin account after a grace period. ' +
      'Immediately deactivates the account and bans Supabase Auth. ' +
      'Grace period: 7, 14, 30, or 60 days.',
  })
  @Roles(ROLE_ID.SUPER_ADMIN)
  async scheduleDeleteAdmin(
    @Args('input') input: ScheduleDeleteAdminInput,
    @CurrentUser() admin: AuthUser,
  ): Promise<ScheduleDeleteAdminPayload> {
    return this.adminService.scheduleDeleteAdmin(input, admin);
  }

  /**
   * cancelScheduledDelete — ยกเลิกการกำหนดลบบัญชี admin + reactivate
   *
   * @example
   * mutation {
   *   cancelScheduledDelete(input: { adminId: "uuid" }) {
   *     user { id email isActive }
   *     reactivated
   *   }
   * }
   */
  @Mutation(() => CancelScheduledDeletePayload, {
    description:
      'Super Admin only: Cancel a scheduled deletion for an admin account. ' +
      'Reactivates the account and unbans Supabase Auth.',
  })
  @Roles(ROLE_ID.SUPER_ADMIN)
  async cancelScheduledDelete(
    @Args('input') input: CancelScheduledDeleteInput,
    @CurrentUser() admin: AuthUser,
  ): Promise<CancelScheduledDeletePayload> {
    return this.adminService.cancelScheduledDelete(input, admin);
  }

  @Mutation(() => ToggleAdminStatusPayload, {
    description:
      'Super Admin only: Activate or deactivate an admin account. ' +
      'Deactivate revokes Supabase Auth sessions (ban). ' +
      'Activate clears any scheduled deletion. Sends notification email.',
  })
  @Roles(ROLE_ID.SUPER_ADMIN)
  async toggleAdminStatus(
    @Args('input') input: ToggleAdminStatusInput,
    @CurrentUser() admin: AuthUser,
  ): Promise<ToggleAdminStatusPayload> {
    return this.adminService.toggleAdminStatus(input, admin);
  }

  // ─────────────────────────────────────────────────────────────────────────
  // EDIT ADMIN INFO
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * editAdminInfo — Super Admin แก้ไขข้อมูล admin (ชื่อ, email, role)
   *
   * Guard: SUPER_ADMIN (role=4) เท่านั้น — override class-level @Roles
   *
   * @example
   * mutation {
   *   editAdminInfo(input: {
   *     adminId: "uuid-here"
   *     firstName: "สมชาย"
   *     email: "new@payung.app"
   *     role: 4
   *   }) {
   *     user { id email displayName role }
   *   }
   * }
   */
  @Mutation(() => EditAdminInfoPayload, {
    description:
      'Super Admin only: Edit an admin account (name, email, role). ' +
      'Syncs email to Supabase Auth. Protects the last active Super Admin from demotion. ' +
      'Records audit log.',
  })
  @Roles(ROLE_ID.SUPER_ADMIN)
  async editAdminInfo(
    @Args('input') input: EditAdminInfoInput,
    @CurrentUser() admin: AuthUser,
  ): Promise<EditAdminInfoPayload> {
    return this.adminService.editAdminInfo(input, admin);
  }

  // ─────────────────────────────────────────────────────────────────────────
  // ADMIN UPDATE CAREGIVER INFO
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * adminUpdateCaregiverInfo — Admin แก้ไข firstName/lastName/idCardNumber/email ของ caregiver
   *
   * @example
   * mutation {
   *   adminUpdateCaregiverInfo(input: {
   *     caregiverId: "uuid-here"
   *     firstName: "สมชาย"
   *     lastName: "ใจดี"
   *     idCardNumber: "1234567890123"
   *     email: "new@example.com"
   *   }) {
   *     id firstName lastName idCardNumber email
   *   }
   * }
   */
  @Mutation(() => AdminUpdateCaregiverInfoPayload, {
    description:
      'Admin only: Edit caregiver personal info (firstName, lastName, idCardNumber, email). ' +
      'Email change syncs to Supabase Auth. idCardNumber must be exactly 13 digits. ' +
      'Records audit log.',
  })
  async adminUpdateCaregiverInfo(
    @Args('input') input: AdminUpdateCaregiverInfoInput,
    @CurrentUser() admin: AuthUser,
  ): Promise<AdminUpdateCaregiverInfoPayload> {
    return this.adminService.adminUpdateCaregiverInfo(input, admin);
  }

  // ─────────────────────────────────────────────────────────────────────────
  // ADMIN EDIT USER
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * adminEditUser — Admin แก้ไขข้อมูล user ทั่วไป (patient/caregiver)
   *
   * @example
   * mutation {
   *   adminEditUser(input: {
   *     userId: "uuid-here"
   *     displayName: "สมชาย ใจดี"
   *     phone: "0812345678"
   *     bio: "ผู้ดูแลผู้สูงอายุมืออาชีพ"
   *   }) {
   *     id email displayName phone bio
   *   }
   * }
   */
  @Mutation(() => User, {
    description:
      'Admin only: Edit a regular user profile (displayName, email, phone, address, bio). ' +
      'Cannot be used on admin/super_admin accounts — use editAdminInfo instead. ' +
      'Syncs email to Supabase Auth if changed. Records audit log.',
  })
  async adminEditUser(
    @Args('input') input: AdminEditUserInput,
    @CurrentUser() admin: AuthUser,
  ): Promise<User> {
    return this.adminService.adminEditUser(input, admin);
  }

  // ─────────────────────────────────────────────────────────────────────────
  // FIELD LOCK (PYG-145)
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * toggleFieldLock — Admin lock/unlock field ของ caregiver หรือ user
   *
   * @example
   * mutation {
   *   toggleFieldLock(input: {
   *     entityType: CAREGIVER_PROFILE
   *     entityId: "uuid-here"
   *     fieldName: "phone"
   *     lock: true
   *   }) {
   *     success fieldName locked lockedBy lockedAt
   *   }
   * }
   */
  @Mutation(() => FieldLockResult, {
    description:
      'Admin only: Lock or unlock a specific field of a caregiver profile or user. ' +
      'Locked fields cannot be edited by the user until unlocked. Records audit log.',
  })
  async toggleFieldLock(
    @Args('input') input: ToggleFieldLockInput,
    @CurrentUser() admin: AuthUser,
  ): Promise<FieldLockResult> {
    return this.adminService.toggleFieldLock(input, admin);
  }

  /**
   * lockedFields — ดู active locks ทั้งหมดของ entity
   *
   * เปิดให้ทุก role ที่ authenticate แล้วเรียกได้ (caregiver ต้องรู้ว่า field ไหนถูก lock)
   *
   * @example
   * query {
   *   lockedFields(entityType: CAREGIVER_PROFILE, entityId: "uuid-here") {
   *     fieldName lockedBy lockedAt
   *   }
   * }
   */
  @Query(() => [LockedField], {
    description:
      'All authenticated users: Get all currently locked fields for an entity. ' +
      'Caregivers need this to know which fields they cannot edit.',
  })
  @Roles(ROLE_ID.PATIENT, ROLE_ID.CAREGIVER, ROLE_ID.ADMIN, ROLE_ID.SUPER_ADMIN)
  async lockedFields(
    @Args('entityType', { type: () => EntityTypeEnum }) entityType: EntityTypeEnum,
    @Args('entityId') entityId: string,
  ): Promise<LockedField[]> {
    return this.adminService.getLockedFields(entityType, entityId);
  }
}
