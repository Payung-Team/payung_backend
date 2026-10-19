import { Field, ID, InputType } from '@nestjs/graphql';
import {
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  MinLength,
} from 'class-validator';

/**
 * PYG-385 — เพิ่ม/แก้ไข/นำออกโปรไฟล์ผู้รับบริการในกลุ่มครอบครัว
 *
 * ทุก input มี groupId เสมอ เพราะ FamilyGroupGuard อ่าน input.groupId เพื่อเช็คว่า
 * ผู้เรียกเป็นสมาชิก ACTIVE ของกลุ่มนั้นก่อน (สิทธิ์ระดับกลุ่ม) ส่วนสิทธิ์ระดับ "เจ้าของ
 * โปรไฟล์" (เฉพาะคนเพิ่มถึงแก้/ลบได้) ตรวจในเซอร์วิสอีกชั้น
 *
 * ★ ฟิลด์จำกัดที่ name + nickname ให้ตรงกับ care-recipients CRUD เดิม (REST) และกับ
 *   GroupCareRecipient ที่คืนออก — ข้อมูลสุขภาพเป็น PDPA ยังไม่เปิดให้แก้ผ่านที่นี่
 */
@InputType()
export class AddGroupCareRecipientInput {
  @Field(() => ID, {
    description: 'กลุ่มที่จะเพิ่มโปรไฟล์เข้าไป — ผู้เรียกต้องเป็นสมาชิก ACTIVE',
  })
  @IsUUID()
  groupId: string;

  @Field({ description: 'ชื่อ-นามสกุลของผู้รับบริการ' })
  @IsString()
  @IsNotEmpty()
  @MinLength(1)
  @MaxLength(255)
  name: string;

  @Field({ nullable: true, description: 'ชื่อเล่น (ถ้ามี)' })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  nickname?: string;
}

@InputType()
export class UpdateGroupCareRecipientInput {
  @Field(() => ID, { description: 'กลุ่มที่โปรไฟล์อยู่' })
  @IsUUID()
  groupId: string;

  @Field(() => ID, { description: 'โปรไฟล์ที่จะแก้ไข' })
  @IsUUID()
  recipientId: string;

  @Field({ nullable: true, description: 'ชื่อ-นามสกุลใหม่' })
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  name?: string;

  @Field({ nullable: true, description: 'ชื่อเล่นใหม่ (ส่งค่าว่างเพื่อลบชื่อเล่น)' })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  nickname?: string;
}

@InputType()
export class RemoveGroupCareRecipientInput {
  @Field(() => ID, { description: 'กลุ่มที่โปรไฟล์อยู่' })
  @IsUUID()
  groupId: string;

  @Field(() => ID, { description: 'โปรไฟล์ที่จะนำออกจากกลุ่ม' })
  @IsUUID()
  recipientId: string;
}
