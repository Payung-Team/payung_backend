/**
 * PYG-517 — รายชื่อสมาชิกในกลุ่มสำหรับ shortcut + autofill ตอนจองแทน
 *
 * ต่างจาก `GroupCareRecipient` ตรงที่นี่มองเป็น "รายชื่อคน" ไม่ใช่ "รายชื่อโปรไฟล์"
 *   คนหนึ่งคน = หนึ่งรายการเสมอ แม้ยังไม่มีโปรไฟล์ในกลุ่ม (FE จะได้แสดงปุ่มให้กดได้)
 *
 * ★ ข้อมูลใน `details` มาจากโปรไฟล์ของสมาชิกคนนั้น **ในกลุ่มนี้เท่านั้น**
 *   ไม่ดึงโปรไฟล์ส่วนตัว (`family_group_id = NULL` รวมใบ is_self จาก Onboarding)
 *   ข้อมูลสุขภาพส่วนตัวยังไม่ได้แชร์เข้ากลุ่ม — การเอามาโชว์ให้สมาชิกคนอื่นคือการ
 *   เปิดเผยข้อมูลอ่อนไหวโดยไม่มีความยินยอม (PDPA ม.26 · consent disclose_to_family_group)
 *   โปรไฟล์ส่วนตัวถูกคัดลอกเข้ากลุ่มตอน "จองจริง" ตามกลไกเดิมของ PYG-500
 */
import { Field, Float, ID, Int, ObjectType } from '@nestjs/graphql';

@ObjectType({ description: 'ข้อมูลผู้รับบริการสำหรับเติมฟอร์มจองแทน' })
export class GroupBookingRecipientDetails {
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

  // ── ที่อยู่ (แก้ได้ตอนจอง ต่างจากชื่อ) ────────────────────────────────
  @Field({ nullable: true, description: 'ที่อยู่ที่ให้บริการ' })
  addressLine?: string;

  @Field({ nullable: true }) province?: string;
  @Field({ nullable: true }) district?: string;
}

@ObjectType({
  description:
    'สมาชิก ACTIVE หนึ่งคนในกลุ่ม พร้อมข้อมูลผู้รับบริการสำหรับ autofill ตอนจองแทน',
})
export class GroupBookingRecipient {
  @Field(() => ID, { description: 'users.id ของสมาชิก — ส่งกลับเป็น memberUserId ตอนจอง' })
  memberUserId: string;

  @Field({
    description:
      'ชื่อ-นามสกุลจากบัญชีของสมาชิก — แก้ไม่ได้ (PYG-516 ปฏิเสธ patientName ที่ส่งมา)',
  })
  name: string;

  /**
   * ★ ค่าคงที่ `true` โดยตั้งใจ — ไม่ใช่ flag ที่พลิกได้
   *   มีไว้ให้ FE อ่านแล้วตั้งช่องเป็น read-only โดยไม่ต้อง hardcode กติกาไว้ฝั่งตัวเอง
   *   วันที่กติกาเปลี่ยน (ถ้าเปลี่ยน) BE เปลี่ยนที่เดียวแล้ว FE ตามได้ทันที
   */
  @Field({ description: 'ชื่อ-นามสกุลล็อกเสมอ — FE ต้องแสดงเป็น read-only' })
  nameLocked: boolean;

  @Field({ nullable: true, description: 'ชื่อเล่นจากโปรไฟล์ในกลุ่ม (ถ้ามี)' })
  nickname?: string;

  /**
   * ★ `false` = ยังไม่มีโปรไฟล์ในกลุ่มนี้ (อาจมีโปรไฟล์ส่วนตัวอยู่ แต่เราไม่ดึงมา)
   *   FE ปล่อยช่องว่างให้คนจองกรอก · พอจองจริงกลไกเดิมจะสร้าง/คัดลอกโปรไฟล์เข้ากลุ่มให้
   */
  @Field({ description: 'มีโปรไฟล์ผู้รับบริการในกลุ่มนี้แล้วหรือยัง' })
  hasProfile: boolean;

  @Field(() => GroupBookingRecipientDetails, {
    nullable: true,
    description: 'null เมื่อยังไม่มีโปรไฟล์ในกลุ่ม — FE ปล่อยช่องว่างให้กรอก',
  })
  details?: GroupBookingRecipientDetails;
}
