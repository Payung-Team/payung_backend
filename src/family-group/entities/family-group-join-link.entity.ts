import { Field, ID, Int, ObjectType } from '@nestjs/graphql';

/**
 * FamilyGroupJoinLink (PYG-416 · SCR-FG2-001) — ลิงก์เข้าร่วมกลุ่ม ฝั่งสมาชิกในกลุ่ม
 *
 * ★ type นี้ "ห้าม" ส่งให้ใครที่ไม่ใช่สมาชิก ACTIVE ของกลุ่มนั้น เพราะมี url เต็มอยู่ข้างใน
 *   ใครเปิดดูได้บ้าง (Amendment 1 · แก้ใน PYG-478):
 *     - อ่าน/คัดลอก (groupJoinLink)        → สมาชิก ACTIVE ทุกคน ทั้ง OWNER และ MEMBER (B9)
 *       ต้องผ่าน @GroupRole('MEMBER') + ตรวจสมาชิก ACTIVE ซ้ำใน service
 *     - สร้าง/หมุน/ยกเลิก (create/rotate/revoke) → เจ้าของเท่านั้น (B1)
 *       ต้องผ่าน @GroupRole('OWNER') + assertOwner ซ้ำใน service
 *   คนนอกกลุ่มที่กดลิงก์เข้ามาให้ใช้ JoinLinkPreview ด้านล่างแทน
 *
 *   หมายเหตุ: คอมเมนต์ในไฟล์ prisma/migrations/20260902000000_family_group_join_links
 *   ยังเขียนว่า "resolver คืนค่านี้ให้เฉพาะ OWNER" ซึ่งเป็นข้อความก่อน Amendment 1
 *   ไม่ได้แก้ไฟล์นั้นเพราะ migration นั้น apply ลงดีบีไปแล้ว (แก้แล้ว checksum เปลี่ยน)
 *   ให้ถือตามคอมเมนต์ในไฟล์นี้เป็นหลัก — RLS ของตารางยังปิดตายเหมือนเดิม ไม่มีอะไรเปลี่ยน
 *
 * ทำไมถึงมีทั้ง remainingUses และ maxUses ทั้งที่ FE ลบเองได้?
 *   usedCount ไม่ได้ส่งออกไป (มันคือข้อมูลภายใน ไม่ใช่สิ่งที่เจ้าของกลุ่มสนใจ)
 *   สิ่งที่คนกดดูอยากรู้คือ "เหลืออีกกี่คน" → ตอบตรง ๆ ดีกว่าให้ FE คำนวณเอง
 *   แล้วคิดผิดตอน maxUses เป็น null (ไม่จำกัด)
 */
@ObjectType()
export class FamilyGroupJoinLink {
  @Field(() => ID)
  id: string;

  @Field(() => ID)
  groupId: string;

  @Field({
    description:
      'URL เต็มสำหรับคัดลอกไปส่งต่อ — สมาชิก ACTIVE ของกลุ่มทุกคนเห็นค่านี้ คนนอกกลุ่มไม่เห็น',
  })
  url: string;

  @Field({ description: 'ลิงก์ใช้ได้ถึงเมื่อไหร่' })
  expiresAt: Date;

  @Field(() => Int, {
    nullable: true,
    description: 'จำนวนคนสูงสุดที่เข้าได้ด้วยลิงก์ใบนี้ — null = ไม่จำกัด',
  })
  maxUses?: number | null;

  @Field(() => Int, {
    nullable: true,
    description: 'เหลืออีกกี่คนถึงจะเต็มโควตา — null = ไม่จำกัด',
  })
  remainingUses?: number | null;

  @Field(() => Int, {
    description: 'จำนวนสมาชิก ACTIVE ในกลุ่มตอนนี้ (ไว้เทียบกับ memberLimit)',
  })
  memberCount: number;

  @Field(() => Int, {
    description: 'เพดานสมาชิกของกลุ่ม (FAMILY_GROUP_MAX_MEMBERS)',
  })
  memberLimit: number;

  @Field({
    description: 'ลิงก์ยังใช้ได้อยู่หรือไม่ (ยังไม่หมดอายุ/ยังไม่เต็ม)',
  })
  isUsable: boolean;

  @Field()
  createdAt: Date;
}

/**
 * JoinLinkPreview (PYG-416) — สิ่งที่คน "ที่ถือลิงก์" เห็นก่อนกดยืนยันเข้าร่วม
 *
 * ★ ของใหม่ที่ไม่มีในโมเดลคำเชิญทางอีเมลเดิม และจำเป็นกว่าที่คิด
 *   เมื่อก่อนคนกดลิงก์มาจากอีเมลที่จ่าหน้าถึงตัวเอง จึงรู้อยู่แล้วว่ากำลังจะเข้ากลุ่มอะไร
 *   ตอนนี้ลิงก์เดินทางผ่านไลน์ ส่งต่อกันไปเรื่อย ๆ คนกดอาจไม่รู้เลยว่าปลายทางคืออะไร
 *   → ต้องมีหน้าที่บอกว่า "กำลังจะเข้ากลุ่มชื่อนี้ ที่สร้างโดยคนนี้" ก่อนเสมอ
 *
 * ★ ฟิลด์ในนี้ถูกคัดมาแล้วว่า "หลุดไปกับลิงก์ที่ส่งต่อกันได้โดยไม่เสียหาย"
 *   ไม่มีรายชื่อสมาชิก ไม่มีอีเมล ไม่มี id ของกลุ่มที่เอาไปยิง query อื่นต่อได้
 */
@ObjectType()
export class JoinLinkPreview {
  @Field({ description: 'ชื่อกลุ่มที่กำลังจะเข้าร่วม' })
  groupName: string;

  @Field(() => String, {
    nullable: true,
    description: 'ชื่อที่แสดงของเจ้าของกลุ่ม — null ถ้าบัญชีนั้นถูกลบไปแล้ว',
  })
  ownerName?: string | null;

  @Field(() => Int, { description: 'ตอนนี้ในกลุ่มมีกี่คน' })
  memberCount: number;

  @Field({
    description:
      'ลิงก์นี้ยังกดเข้าร่วมได้อยู่ไหม — false แปลว่าหมดอายุ/ถูกยกเลิก/เต็มแล้ว',
  })
  isUsable: boolean;

  @Field(() => String, {
    nullable: true,
    description:
      "เหตุผลที่กดไม่ได้ — 'EXPIRED' | 'REVOKED' | 'EXHAUSTED' | 'GROUP_FULL' (null เมื่อ isUsable = true)",
  })
  unusableReason?: string | null;

  @Field({
    description: 'ผู้เรียกเป็นสมาชิก ACTIVE ของกลุ่มนี้อยู่แล้วหรือไม่',
  })
  alreadyMember: boolean;
}
