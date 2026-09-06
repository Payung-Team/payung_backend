import { Field, ID, ObjectType } from '@nestjs/graphql';

/**
 * CareLog — 1 รายการ "บันทึกจากผู้ดูแล" (PYG-361)
 *
 * ★ display-only เพื่อความสบายใจของผู้รับบริการเท่านั้น — จำนวน/เนื้อหาของรายการเหล่านี้
 *   ต้องไม่มีผลต่อ proofOfWork.verdict หรือการปล่อยเงินเด็ดขาด
 */
@ObjectType()
export class CareLog {
  @Field(() => ID) id: string;
  @Field(() => ID) bookingId: string;

  @Field({ description: "'vitals' | 'food' | 'medication' | 'activity' | 'other'" })
  category: string;

  @Field() body: string;

  @Field({ nullable: true, description: 'signed URL ของรูปประกอบ — หมดอายุใน 1 ชม.' })
  photoUrl?: string;

  @Field({ description: 'เวลาของเซิร์ฟเวอร์ — เวลาที่ถือเป็นทางการ' })
  serverTs: Date;

  @Field({ nullable: true, description: 'เวลาที่เครื่อง client อ้าง — metadata เท่านั้น' })
  deviceTs?: Date;
}
