/**
 * MyProfilePhotoReview — สถานะรีวิวรูปโปรไฟล์ใบล่าสุดของผู้ดูแลที่ login อยู่ (PYG-488)
 *
 * ให้หน้าแก้โปรไฟล์อ่านสถานะจาก backend แทน localStorage
 * (เดิมแอดมินอนุมัติ/ปฏิเสธแล้วหน้าผู้ดูแลยังขึ้น "รออนุมัติ" ค้าง)
 */
import { Field, ID, ObjectType } from '@nestjs/graphql';

@ObjectType({ description: 'Review status of the current caregiver\'s latest uploaded profile photo' })
export class MyProfilePhotoReview {
  @Field(() => ID)
  documentId!: string;

  @Field({ description: 'pending | approved | rejected' })
  reviewStatus!: string;

  /** signed URL (1 ชม.) ของใบนั้น — ให้เจ้าตัวเห็นรูปที่รอ/ถูกปฏิเสธ · approved = null (ใช้ me.avatarUrl) */
  @Field({ nullable: true, description: 'Signed URL of this photo (pending / rejected only)' })
  photoUrl?: string;

  /** เหตุผลจากแอดมิน — มีเฉพาะ rejected */
  @Field({ nullable: true, description: 'Rejection reason from admin' })
  reason?: string;

  @Field()
  uploadedAt!: Date;

  @Field({ nullable: true })
  reviewedAt?: Date;
}
