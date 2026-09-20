import { Field, ID, ObjectType } from '@nestjs/graphql';

/**
 * ฟีดกิจกรรมของกลุ่ม (FG-3 / PYG-421) — ชนิดข้อมูลที่ส่งออกทาง GraphQL
 *
 * ═══ ทำไมฟีดนี้ต้องเป็น keyset ไม่ใช่ offset (page/limit) แบบ connection อื่นในโปรเจกต์ ═══
 *
 * ตารางอื่น (dispute queue / transaction) เป็นรายการที่ "โตช้าและอ่านแบบเปิดหน้าเลข"
 * แต่ฟีดกิจกรรมเป็น append-only ที่มีแถวใหม่แทรกหัวตารางตลอดเวลา และ FE เป็น
 * infinite scroll (PYG-422) → ถ้าใช้ OFFSET:
 *
 *   1. มีคนทำอะไรสักอย่างระหว่างที่ผู้ใช้เลื่อนหน้า แถวทั้งกองจะเลื่อนลง 1
 *      หน้า 2 ที่ขอด้วย OFFSET 20 จะได้แถวสุดท้ายของหน้า 1 ซ้ำมาอีกรอบ
 *      (หรือข้ามแถวหายไปเลยถ้ามีคนลบ) = ฟีดที่มีรายการซ้ำ/หาย โดยไม่มี error ให้เห็น
 *   2. OFFSET n บังคับให้ดีบีอ่านทิ้ง n แถวก่อนเสมอ → ยิ่งเลื่อนลึกยิ่งช้า
 *      ส่วน keyset กระโดดเข้า index ตรงจุดได้เลย เร็วเท่ากันทุกหน้า
 *
 * cursor จึงเป็นคู่ (createdAt, id) ไม่ใช่ createdAt เดี่ยว ๆ — เพราะกิจกรรมที่เขียนใน
 * transaction เดียวกันได้ created_at เท่ากันเป๊ะ (now() ของ Postgres คงที่ทั้ง transaction)
 * cursor ที่ดูแค่ createdAt จะข้ามแถวที่เวลาเท่ากันทิ้งไปทั้งกอง
 * → ตรงกับ index "family_group_activity_group_id_created_at_idx" (group_id, created_at DESC, id DESC)
 */

/**
 * คนที่ทำกิจกรรมนั้น — null ได้ทั้งก้อนถ้าบัญชีถูกลบไปแล้ว
 *
 * ★ ฟีดไม่ join ตารางสมาชิก จึงไม่มีฟิลด์ role ในนี้โดยตั้งใจ
 *   บทบาท "ตอนนี้" ของคนคนนั้นไม่ใช่ความจริงของ "ตอนที่เกิดเหตุการณ์"
 *   ถ้าโชว์ role ปัจจุบันคู่กับเหตุการณ์เก่า ฟีดจะเล่าเรื่องผิด
 *   (เช่น คนที่ตอนนั้นเป็นเจ้าของ แต่โอนสิทธิ์ไปแล้ว จะกลายเป็น "สมาชิกลบกลุ่ม")
 */
@ObjectType()
export class FamilyGroupActivityActor {
  @Field(() => ID, { description: 'users.id ของคนที่ทำ' })
  userId: string;

  @Field(() => String, {
    nullable: true,
    description: 'ชื่อที่แสดง — null ถ้าผู้ใช้ยังไม่ได้ตั้งชื่อ',
  })
  displayName?: string;

  @Field(() => String, { nullable: true, description: 'รูปโปรไฟล์' })
  avatarUrl?: string;
}

/** กิจกรรม 1 รายการในฟีด */
@ObjectType()
export class FamilyGroupActivityItem {
  @Field(() => ID, { description: 'family_group_activity.id' })
  id: string;

  @Field(() => FamilyGroupActivityActor, {
    nullable: true,
    description:
      'ผู้ลงมือ — null เมื่อบัญชีถูกลบไปแล้ว (FE ต้องแสดงเป็น "ผู้ใช้ที่ถูกลบ" ไม่ใช่ซ่อนแถวทิ้ง)',
  })
  actor?: FamilyGroupActivityActor;

  @Field(() => String, {
    description:
      "ชนิดเหตุการณ์ เช่น 'GROUP_CREATED' | 'MEMBER_JOINED' | 'JOIN_LINK_ROTATED' — " +
      'ค่าเต็มดูที่ ACTIVITY_ACTION ใน family-group.constants.ts · FE เป็นคนแปลเป็นข้อความ TH/EN (PYG-422)',
  })
  action: string;

  @Field(() => String, {
    nullable: true,
    description: "'GROUP' | 'MEMBER' | 'JOIN_LINK' | 'RECIPIENT' | 'BOOKING'",
  })
  targetType?: string;

  @Field(() => ID, {
    nullable: true,
    description:
      'id ของสิ่งที่เหตุการณ์ชี้ไป — polymorphic ตาม targetType (ไม่มี FK ในดีบี)',
  })
  targetId?: string;

  /**
   * ★ เป็น "JSON string" ไม่ใช่ scalar JSON — repo นี้ยังไม่มี graphql-type-json ใน deps
   *   แพตเทิร์นเดียวกับ Notification.data (PYG-292) และ PaymentStatusHistory
   *   วันไหนเพิ่ม dependency แล้วค่อยเปลี่ยนเป็น GraphQLJSON พร้อมกันทั้งโปรเจกต์
   *
   * ★★ ห้ามใส่ token หรือ URL ของลิงก์เข้าร่วมลง metadata เด็ดขาด (คำสั่งตรงจาก PYG-422)
   *    ฟีดนี้สมาชิกทุกคนอ่านได้ — ใครอ่านฟีดได้ก็จะพาคนนอกเข้ากลุ่มได้ทันที
   *    ตอนนี้ฝั่งเขียน (createJoinLink/rotate/revoke) ใส่มาแค่ maxUses/expiresAt/usedCount
   */
  @Field(() => String, {
    description:
      'รายละเอียดเพิ่มเติมในรูป JSON string เช่น \'{"oldName":"บ้านยาย","newName":"บ้านย่า"}\' — client ใช้ JSON.parse() (ไม่มีข้อมูลเลย = "{}")',
  })
  metadata: string;

  @Field({ description: 'เกิดเมื่อไหร่' })
  createdAt: Date;

  @Field(() => String, {
    description:
      'cursor ของแถวนี้ — ส่งกลับมาเป็น after เพื่อขอหน้าถัดไปจากจุดนี้ (ค่าทึบ ห้าม parse ฝั่ง client)',
  })
  cursor: string;
}

/**
 * ข้อมูลการแบ่งหน้าแบบ keyset
 *
 * ★ ไม่มี totalCount โดยตั้งใจ — ต่างจาก connection อื่นในโปรเจกต์
 *   COUNT(*) บนตาราง append-only ที่โตไม่จำกัดคือ full scan ทุกครั้งที่เลื่อนหน้า
 *   และ infinite scroll ไม่ได้ใช้ตัวเลขนั้นแสดงผลอะไรเลย จ่ายไปก็เปล่า ๆ
 */
@ObjectType()
export class FamilyGroupActivityPageInfo {
  @Field(() => String, {
    nullable: true,
    description:
      'cursor ของแถวสุดท้ายในหน้านี้ — null เมื่อหน้านี้ว่าง · ส่งค่านี้เป็น after ของครั้งถัดไป',
  })
  endCursor?: string;

  @Field({
    description:
      'ยังมีของเก่ากว่านี้ให้โหลดอีกไหม — FE ใช้ตัดสินว่าจะยิงคำขอหน้าถัดไปหรือหยุด',
  })
  hasNextPage: boolean;
}

/** ผลลัพธ์ของ query familyGroupActivity */
@ObjectType()
export class FamilyGroupActivityConnection {
  @Field(() => [FamilyGroupActivityItem], {
    description: 'กิจกรรมเรียงใหม่สุดก่อน (created_at DESC, id DESC)',
  })
  nodes: FamilyGroupActivityItem[];

  @Field(() => FamilyGroupActivityPageInfo)
  pageInfo: FamilyGroupActivityPageInfo;
}
