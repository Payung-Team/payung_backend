/**
 * ChangeUserRoleInput — Input สำหรับ mutation changeUserRole
 *
 * Guards (enforce ใน service):
 * - ห้าม admin เปลี่ยน role ตัวเอง
 * - ห้ามเปลี่ยนเป็น admin/super_admin (privilege escalation)
 * - อนุญาตได้เฉพาะ: patient (1) ↔ caregiver (2)
 */
import { InputType, Field, ID, Int } from '@nestjs/graphql';
import { IsInt, IsNotEmpty, IsUUID, Max, Min } from 'class-validator';

@InputType()
export class ChangeUserRoleInput {
  /** UUID ของ user ที่ต้องการเปลี่ยน role */
  @Field(() => ID, { description: 'UUID of the user to change role' })
  @IsUUID('4', { message: 'userId ต้องเป็น UUID ที่ถูกต้อง' })
  @IsNotEmpty({ message: 'กรุณาระบุ userId' })
  userId!: string;

  /**
   * Role ID ใหม่
   * 1 = patient, 2 = caregiver
   * ห้ามเปลี่ยนเป็น 3 (admin) หรือ 4 (super_admin) — enforce ใน service
   */
  @Field(() => Int, { description: 'New role ID (1=patient, 2=caregiver). Cannot be 3 or 4.' })
  @IsInt({ message: 'newRole ต้องเป็นจำนวนเต็ม' })
  @Min(1, { message: 'newRole ต้องไม่น้อยกว่า 1' })
  @Max(4, { message: 'newRole ต้องไม่เกิน 4' })
  newRole!: number;
}
