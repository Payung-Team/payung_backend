/**
 * AdminUserDetailPayload — Output type สำหรับ query adminUserDetail
 *
 * แสดงข้อมูล user ครบถ้วน + caregiver info (ถ้า role=2) + KYC status + suspended state
 */
import { ObjectType, Field, Int } from '@nestjs/graphql';
import { User } from '../../identity/auth/entities/user.entity';
import { Caregiver } from '../../identity/kyc/entities/caregiver.entity';

@ObjectType({ description: 'Full user detail for admin management' })
export class AdminUserDetailPayload {
  /** ข้อมูล user ครบถ้วน */
  @Field(() => User, { description: 'User profile' })
  user!: User;

  /**
   * ข้อมูล caregiver (ถ้ามี)
   * null ถ้า user ไม่ใช่ caregiver หรือยังไม่มี caregiver record
   */
  @Field(() => Caregiver, { nullable: true, description: 'Caregiver profile (null if not a caregiver)' })
  caregiver?: Caregiver;

  /**
   * สถานะ KYC ปัจจุบัน
   * "none" | "pending" | "verified" | "rejected" | "n/a" (ถ้าไม่ใช่ caregiver)
   */
  @Field({ description: 'Current KYC status: none | pending | verified | rejected | n/a' })
  kycStatus!: string;

  /** true ถ้า user ถูกระงับ */
  @Field({ description: 'Whether the user is currently suspended' })
  isSuspended!: boolean;

  /** วันที่กำหนดลบบัญชี (null ถ้าไม่มี) */
  @Field({ nullable: true, description: 'Scheduled permanent deletion date' })
  scheduledDeleteAt?: Date;

  /** จำนวน audit log entries ที่เกี่ยวกับ user นี้ */
  @Field(() => Int, { description: 'Number of admin actions taken on this user' })
  auditLogCount!: number;
}
