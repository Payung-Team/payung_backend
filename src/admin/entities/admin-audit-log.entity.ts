/**
 * AdminAuditLog Entity — GraphQL type สำหรับ admin audit trail
 *
 * ทุก admin action ที่กระทบ user จะถูกบันทึกเป็น AdminAuditLog record
 * เพื่อ accountability และ compliance
 */
import { ObjectType, Field, ID } from '@nestjs/graphql';

@ObjectType({ description: 'An admin audit log entry recording an action on a user' })
export class AdminAuditLog {
  @Field(() => ID)
  id!: string;

  /** ID ของ admin ที่ทำ action */
  @Field({ description: 'Admin user ID who performed the action' })
  adminId!: string;

  /** ประเภท action: suspend_user, activate_user, change_role, ... */
  @Field({ description: 'Action type (e.g. suspend_user, activate_user, change_role)' })
  action!: string;

  /** ID ของ user ที่ถูกกระทำ */
  @Field({ description: 'Target user ID affected by this action' })
  targetUserId!: string;

  /**
   * ข้อมูลเพิ่มเติม — serialize เป็น JSON string ก่อนส่งให้ client
   * ตัวอย่าง: '{"previousRole":1,"newRole":2}'
   * client parse ด้วย JSON.parse() เมื่อต้องการใช้
   */
  @Field(() => String, { nullable: true, description: 'JSON-stringified additional details' })
  details?: string;

  /** วันเวลาที่ทำ action */
  @Field({ description: 'When this action was performed' })
  createdAt!: Date;
}
