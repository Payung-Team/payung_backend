import { Field, ID, Int, ObjectType } from '@nestjs/graphql';

/**
 * BookingTask — รายการงานย่อย 1 ชิ้นของ booking (PYG-361)
 *
 * ★ display-only: doneAt/doneBy ไม่มีผลต่อ proofOfWork.verdict หรือ review_reasons เด็ดขาด
 *   ผู้ดูแลทำงานครบถ้วนแต่ลืมติ๊กก็ยังต้องได้รับเงินตามปกติ
 */
@ObjectType()
export class BookingTask {
  @Field(() => ID) id: string;
  @Field() description: string;
  @Field({ nullable: true }) timeNote?: string;
  @Field(() => Int) sortOrder: number;

  /** null = ยังไม่ได้ทำ (หรือถูกยกเลิกติ๊ก) — nullable timestamp ไม่ใช่ boolean เพื่อให้รู้ว่า "เมื่อไหร่" */
  @Field({ nullable: true }) doneAt?: Date;

  /** caregivers.id ของคนที่ติ๊ก — null คู่กับ doneAt เสมอ */
  @Field(() => ID, { nullable: true }) doneBy?: string;
}
