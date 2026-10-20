/**
 * AdminUserListPayload — Output types สำหรับ query adminUserList
 *
 * UserSummary: ข้อมูลสรุปของ user แต่ละคนสำหรับแสดงในตาราง (ไม่ expose sensitive fields)
 * AdminUserListPayload: paginated response
 */
import { ObjectType, Field, ID, Int } from '@nestjs/graphql';

/**
 * UserSummary — ข้อมูลสรุปของ user 1 คน สำหรับ admin user list
 */
@ObjectType({ description: 'Summary of a user for admin user management list' })
export class UserSummary {
  @Field(() => ID, { description: 'User UUID' })
  id!: string;

  /** PYG-603: null ได้ — บัญชีที่สมัครด้วยเบอร์โทรไม่มีอีเมล */
  @Field(() => String, {
    nullable: true,
    description: 'User email (null for phone-only accounts)',
  })
  email!: string | null;

  /**
   * PYG-603 — เบอร์ในโปรไฟล์ (users.phone รูปแบบ 0XXXXXXXXX)
   * FE ขอเพิ่ม: บัญชีที่ไม่มีอีเมลและไม่มีชื่อแสดง จะแยกจากกันในตารางแอดมินไม่ได้ถ้าไม่มีเบอร์
   */
  @Field({ nullable: true, description: 'Profile phone number (0XXXXXXXXX)' })
  phone?: string;

  @Field({ nullable: true, description: 'Display name' })
  displayName?: string;

  @Field(() => Int, { description: 'Role ID: 1=patient, 2=caregiver, 3=admin, 4=super_admin' })
  role!: number;

  @Field({ description: 'Whether the account is active (not suspended)' })
  isActive!: boolean;

  /** true ถ้า user ถูกระงับ (isSuspended = !isActive || is_deleted) */
  @Field({ description: 'Whether the user is suspended' })
  isSuspended!: boolean;

  @Field({ description: 'Account creation date' })
  createdAt!: Date;

  @Field({ nullable: true, description: 'When this account is scheduled to be permanently deleted' })
  scheduledDeleteAt?: Date;

  @Field({ nullable: true, description: 'Caregiver number e.g. CG-00001 (role=2 only)' })
  caregiverNumber?: string;

  @Field({ nullable: true, description: 'KYC status: none | pending | verified | rejected (role=2 only)' })
  kycStatus?: string;
}

/**
 * AdminUserListPayload — Paginated response
 */
@ObjectType({ description: 'Paginated user list for admin' })
export class AdminUserListPayload {
  @Field(() => [UserSummary], { description: 'Users for the current page' })
  items!: UserSummary[];

  @Field(() => Int, { description: 'Total number of matching users' })
  total!: number;

  @Field(() => Int, { description: 'Current page number (1-based)' })
  page!: number;

  @Field(() => Int, { description: 'Total number of pages' })
  totalPages!: number;
}
