import { Field, ID, Int, ObjectType } from '@nestjs/graphql';
import { FamilyGroupMemberItem } from './family-group-member.entity';

/**
 * FamilyGroup — กลุ่มครอบครัว 1 กลุ่ม พร้อมรายชื่อสมาชิกที่ยัง ACTIVE
 *
 * ทำไม myRole ถึงอยู่ในนี้ ทั้งที่ไม่ใช่ข้อมูลของ "กลุ่ม"?
 *   เพราะ FE ต้องรู้ตั้งแต่วินาทีที่โหลดหน้าว่าจะโชว์ปุ่มไหน (เปลี่ยนชื่อ/ลบ/เชิญ = เจ้าของเท่านั้น)
 *   ถ้าไม่ส่งมาให้ FE จะต้องไปไล่หาตัวเองใน members[] เอง ซึ่งทุกหน้าจะเขียนตรรกะซ้ำกันคนละแบบ
 *   → ให้ backend ตอบมาตรง ๆ ทีเดียว ปลอดภัยกว่าและ FE ไม่มีทางคิดผิด
 */
@ObjectType()
export class FamilyGroup {
  @Field(() => ID)
  id: string;

  @Field({ description: 'ชื่อกลุ่ม (1–80 ตัวอักษรหลังตัดช่องว่างหัวท้าย)' })
  name: string;

  @Field(() => ID, {
    nullable: true,
    description:
      'users.id ของ "คนสร้าง" — เป็นประวัติ ไม่ใช่เจ้าของปัจจุบัน (โอนสิทธิ์แล้วค่านี้ไม่เปลี่ยน)',
  })
  createdBy?: string;

  @Field({
    description: "'OWNER' | 'MEMBER' — บทบาทของผู้เรียก API ในกลุ่มนี้",
  })
  myRole: string;

  @Field(() => Int, { description: 'จำนวนสมาชิกที่ยัง ACTIVE (รวมเจ้าของ)' })
  memberCount: number;

  @Field(() => [FamilyGroupMemberItem], {
    description:
      'รายชื่อสมาชิกที่ยัง ACTIVE — เจ้าของมาก่อนเสมอ แล้วเรียงตามวันเข้ากลุ่ม',
  })
  members: FamilyGroupMemberItem[];

  @Field()
  createdAt: Date;

  @Field()
  updatedAt: Date;
}

/**
 * ผลของ deleteFamilyGroup — ไม่คืน Boolean เปล่า ๆ
 *
 * เหตุผล: FE ต้องเอา id ไปลบการ์ดกลุ่มออกจาก cache ของ Apollo
 * ถ้าคืนแค่ true/false FE จะต้องจำ id ที่เพิ่งส่งไปเอง ซึ่งพลาดง่ายเวลามีหลายแท็บ
 */
@ObjectType()
export class DeleteFamilyGroupResult {
  @Field(() => ID, { description: 'id ของกลุ่มที่ถูกลบ' })
  id: string;

  @Field({
    description: 'true เสมอเมื่อลบสำเร็จ (ล้มเหลวจะเป็น error ไม่ใช่ false)',
  })
  deleted: boolean;
}

/**
 * ผลของ leaveFamilyGroup
 *
 * ทำไมไม่คืนแค่ Boolean หรือ String เปล่า ๆ?
 *   พอออกจากกลุ่มแล้ว ผู้ใช้จะ "อ่านกลุ่มนั้นไม่ได้อีก" (guard ปัดตกทันที)
 *   ถ้าไม่คืนชื่อกลับมาตรงนี้ FE จะไปหาชื่อมาโชว์ในข้อความยืนยันไม่ได้แล้ว
 *   และ groupId ก็จำเป็นสำหรับล้างการ์ดกลุ่มออกจาก cache ของ Apollo
 */
@ObjectType()
export class LeaveFamilyGroupResult {
  @Field(() => ID, { description: 'id ของกลุ่มที่เพิ่งออกมา' })
  groupId: string;

  @Field({
    description:
      'ชื่อกลุ่ม ณ ตอนที่ออก — เอาไปโชว์ข้อความ "ออกจากกลุ่ม X แล้ว"',
  })
  groupName: string;

  @Field({
    description: 'true เสมอเมื่อออกสำเร็จ (ล้มเหลวจะเป็น error ไม่ใช่ false)',
  })
  left: boolean;
}
