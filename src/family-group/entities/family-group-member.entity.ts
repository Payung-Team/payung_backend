import { Field, ID, ObjectType } from '@nestjs/graphql';

/**
 * FamilyGroupMemberItem — สมาชิก 1 คนในกลุ่ม ที่ส่งกลับให้ FE
 *
 * ★ ส่งกลับเฉพาะสมาชิก status = 'ACTIVE' เท่านั้น
 *   คนที่ LEFT/REMOVED ยังมีแถวอยู่ในดีบี (เพื่อให้ฟีดกิจกรรมอ้างชื่อย้อนหลังได้)
 *   แต่ไม่ควรโผล่ในรายชื่อสมาชิก — จึงไม่มีฟิลด์ status ในนี้เลย
 *   ถ้าวันหนึ่งอยากโชว์ "ประวัติสมาชิก" ให้ทำเป็น query แยก อย่าเติม status ที่นี่
 *   เพราะ FE จะเผลอลืมกรองแล้วคนที่ถูกเตะจะกลับมาโผล่ในหน้าจัดการสมาชิก
 */
@ObjectType()
export class FamilyGroupMemberItem {
  @Field(() => ID, { description: 'family_group_members.id' })
  id: string;

  @Field(() => ID, {
    description:
      'users.id — ใช้เป็นเป้าหมายของ removeMember / transferOwnership',
  })
  userId: string;

  @Field({
    nullable: true,
    description: 'ชื่อที่แสดง (null ได้ถ้าผู้ใช้ยังไม่ตั้งชื่อ)',
  })
  displayName?: string;

  /**
   * PYG-603: null ได้ — สมาชิกที่สมัครด้วยเบอร์โทรไม่มีอีเมล
   * (FE แสดงเบอร์หรือ "—" แทนแล้วใน PR #31 ของ payung_frontend)
   */
  @Field(() => String, {
    nullable: true,
    description:
      'อีเมลของสมาชิก — สมาชิกในกลุ่มเห็นกันได้ (null = บัญชีที่สมัครด้วยเบอร์โทร)',
  })
  email: string | null;

  @Field({ nullable: true, description: 'รูปโปรไฟล์' })
  avatarUrl?: string;

  @Field({
    description:
      "'OWNER' | 'MEMBER' — บทบาทเฉพาะในกลุ่มนี้ ไม่ใช่ role ของทั้งระบบ",
  })
  role: string;

  @Field({ description: 'เข้ากลุ่มเมื่อไหร่' })
  joinedAt: Date;

  @Field({
    description:
      'true = สมาชิกคนนี้คือผู้เรียก API ครั้งนี้เอง — FE ใช้ตัดสินว่าจะโชว์ปุ่ม "ออกจากกลุ่ม" หรือ "นำออก"',
  })
  isMe: boolean;
}
