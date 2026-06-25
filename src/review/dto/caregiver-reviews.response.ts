import { Field, Int, ObjectType } from '@nestjs/graphql';
import { ReviewItem } from '../entities/review-item.entity';

/**
 * ReviewPagination — ข้อมูลแบ่งหน้า (รูปแบบเดียวกับ BookingPagination ของ booking history)
 */
@ObjectType()
export class ReviewPagination {
  @Field(() => Int) page: number;
  @Field(() => Int) limit: number;
  @Field(() => Int) total: number; // จำนวนรีวิว "ที่มองเห็นได้" ทั้งหมดของ caregiver
  @Field(() => Int) totalPages: number;
}

/**
 * CaregiverReviewsResponse — ผลลัพธ์ของ query caregiverReviews
 */
@ObjectType()
export class CaregiverReviewsResponse {
  @Field(() => [ReviewItem]) data: ReviewItem[];
  @Field(() => ReviewPagination) pagination: ReviewPagination;
}
