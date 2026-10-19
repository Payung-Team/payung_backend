import { Field, Float, ID, Int, ObjectType } from '@nestjs/graphql';

@ObjectType()
export class GroupCareRecipientDetails {
  @Field(() => Int, { nullable: true }) age?: number;
  @Field({ nullable: true }) gender?: string;
  @Field(() => Float, { nullable: true }) weight?: number;
  @Field(() => Float, { nullable: true }) height?: number;
  @Field({ nullable: true }) supportLevel?: string;
  @Field({ nullable: true }) bloodGroup?: string;
  @Field(() => [String], { nullable: true }) conditions?: string[];
  @Field({ nullable: true }) medicines?: string;
  @Field({ nullable: true }) allergies?: string;
  @Field({ nullable: true }) careInstructions?: string;
  @Field({ nullable: true }) regularHospital?: string;
}

/** โปรไฟล์ผู้รับบริการของสมาชิกในกลุ่ม พร้อมข้อมูลที่ใช้กรอกฟอร์มจองแทน */
@ObjectType()
export class GroupCareRecipient {
  @Field(() => ID)
  id: string;

  @Field({ description: 'ชื่อ-นามสกุลของผู้รับบริการ' })
  name: string;

  @Field({ nullable: true, description: 'ชื่อเล่น (ถ้ามี) — FE ใช้โชว์ในลิสต์ให้อ่านง่าย' })
  nickname?: string;

  @Field(() => ID, {
    description:
      'users.id ของสมาชิกที่เป็นเจ้าของโปรไฟล์นี้ — FE ใช้โชว์ว่า "โปรไฟล์ที่คุณเพิ่ม" หรือ "สมาชิกคนอื่นเพิ่ม"',
  })
  ownerUserId: string;

  @Field({
    description:
      'ระบุที่มาของข้อมูลเดิมเพื่อรองรับข้อมูลเก่า; ไม่มีผลต่อการแสดงผลหรือสิทธิ์อ่านในกลุ่ม',
  })
  selfReported: boolean;

  @Field(() => GroupCareRecipientDetails, { nullable: true })
  details?: GroupCareRecipientDetails;
}

/**
 * PYG-385 — ผลของการนำโปรไฟล์ออกจากกลุ่ม (unshare)
 * removed=true เสมอเมื่อสำเร็จ; FE ใช้ id เพื่อ evict ออกจาก cache แล้ว refetch ลิสต์
 */
@ObjectType()
export class RemoveGroupCareRecipientResult {
  @Field(() => ID) recipientId: string;
  @Field() removed: boolean;
}
