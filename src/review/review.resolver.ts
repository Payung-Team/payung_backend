import { Args, ID, Mutation, Query, Resolver } from '@nestjs/graphql';
import { UseGuards } from '@nestjs/common';
import { ReviewService } from './review.service';
import { CreateReviewInput } from './dto/create-review.input';
import { CaregiverReviewsInput } from './dto/caregiver-reviews.input';
import { CaregiverReviewsResponse } from './dto/caregiver-reviews.response';
import { ReviewItem } from './entities/review-item.entity';
import { AuthUser, CurrentUser } from '../common/decorators/current-user.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { RolesGuard } from '../common/guards/roles.guard';
import { SupabaseAuthGuard } from '../common/guards/supabase-auth.guard';
import { ROLE_ID } from '../common/constants/roles.constant';

/**
 * ReviewResolver — GraphQL endpoints ของฟีเจอร์รีวิว (PYG-297)
 *
 * หมายเหตุเรื่อง guard: เราใส่ guard "ราย operation" ไม่ใช่ระดับ class
 * เพราะ caregiverReviews เป็น public (เปิดดูโปรไฟล์ caregiver โดยไม่ login ได้)
 * ส่วน createReview/hideReview ต้อง login + ตรวจ role
 */
@Resolver(() => ReviewItem)
export class ReviewResolver {
  constructor(private readonly reviewService: ReviewService) {}

  // patient เท่านั้นถึงเขียนรีวิวได้ (และ service เช็คซ้ำว่าเป็นเจ้าของ booking)
  @Mutation(() => ReviewItem, {
    description:
      'Patient เขียนรีวิวให้ caregiver หลังงาน completed (1 รีวิว/booking)',
  })
  @UseGuards(SupabaseAuthGuard, RolesGuard)
  @Roles(ROLE_ID.PATIENT)
  async createReview(
    @Args('input') input: CreateReviewInput,
    @CurrentUser() user: AuthUser,
  ): Promise<ReviewItem> {
    // ส่ง user.id จาก JWT (ปลอม patientId ผ่าน input ไม่ได้)
    return this.reviewService.createReview(user.id, input);
  }

  // public: ดูรีวิวของ caregiver ได้โดยไม่ต้อง login
  @Query(() => CaregiverReviewsResponse, {
    description:
      'รายการรีวิวที่มองเห็นได้ของ caregiver (ใหม่สุดก่อน) พร้อม pagination — public',
  })
  async caregiverReviews(
    @Args('input') input: CaregiverReviewsInput,
  ): Promise<CaregiverReviewsResponse> {
    return this.reviewService.caregiverReviews(input);
  }

  // admin เท่านั้นถึงซ่อนรีวิวได้
  @Mutation(() => ReviewItem, {
    description: 'Admin ซ่อนรีวิว (is_visible=false) เช่นรีวิวไม่เหมาะสม',
  })
  @UseGuards(SupabaseAuthGuard, RolesGuard)
  @Roles(ROLE_ID.ADMIN)
  async hideReview(
    @Args('reviewId', { type: () => ID }) reviewId: string,
  ): Promise<ReviewItem> {
    return this.reviewService.hideReview(reviewId);
  }
}
