import { Field, ID, Int, ObjectType } from '@nestjs/graphql';

/**
 * ReviewItem — รูปทรงของ "รีวิว 1 รายการ" ที่ backend ส่งกลับให้ frontend
 *
 * ใช้ซ้ำใน 3 operation:
 *  - createReview     → รีวิวที่เพิ่งสร้าง
 *  - caregiverReviews → รายการรีวิวของ caregiver (ทีละหน้า)
 *  - hideReview       → รีวิวหลังถูก admin ซ่อน (isVisible=false)
 *
 * เรื่อง privacy (PDPA): เราเปิดเผยแค่ "ชื่อต้น" ของผู้รีวิวผ่าน field reviewerName เท่านั้น
 * ไม่ส่ง patientId / email / ชื่อเต็ม ออกไป และถ้าผู้รีวิวเลือก isAnonymous = true
 * reviewerName จะกลายเป็นชื่อนิรนามแทน (logic อยู่ใน ReviewService.resolveReviewerName)
 */
@ObjectType()
export class ReviewItem {
  @Field(() => ID)
  id: string;

  @Field(() => Int, { description: 'คะแนนดาว 1–5' })
  rating: number;

  @Field({ nullable: true, description: 'ข้อความรีวิว (ตัด HTML tag ออกแล้ว) — อาจเป็น null ถ้าผู้รีวิวให้แต่ดาว' })
  comment?: string;

  @Field({ description: 'ชื่อต้นของผู้รีวิว หรือ "ผู้ใช้ไม่ระบุชื่อ" ถ้า isAnonymous' })
  reviewerName: string;

  @Field({ description: 'true = ผู้รีวิวเลือกไม่เปิดเผยชื่อ' })
  isAnonymous: boolean;

  @Field({ description: 'false = ถูก admin ซ่อนไว้ (hideReview) จะไม่ถูกนับใน rating รวม' })
  isVisible: boolean;

  @Field({ description: 'เวลาที่สร้างรีวิว (frontend เอาไปทำ "x วันก่อน")' })
  createdAt: Date;
}
