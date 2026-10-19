/**
 * AdminProfilePhotoResolver — แอดมินรีวิวรูปโปรไฟล์ผู้ดูแล (PYG-508 / การ์ดแม่ PYG-488)
 *
 * Queries:
 * - adminProfilePhotoQueue(input): คิวรูปที่รออนุมัติ (รวมผู้ดูแลที่ verified แล้วแต่เปลี่ยนรูป)
 * - adminProfilePhotoReview(caregiverId): รูปที่รออนุมัติ + รูปบัตร + รูปเดิม + ประวัติรีวิวรูป
 *
 * Mutations:
 * - approveProfilePhoto(documentId): อนุมัติ → แสดงรูปนี้ต่อผู้ใช้ทั่วไป · ไม่แตะ kycStatus
 * - rejectProfilePhoto(input): ปฏิเสธพร้อมเหตุผล (บังคับ) · avatar เดิมไม่เปลี่ยน
 *
 * Guards: SupabaseAuthGuard + RolesGuard (admin / super admin) — แบบเดียวกับ AdminResolver
 */
import { Args, ID, Mutation, Query, Resolver } from '@nestjs/graphql';
import { UseGuards } from '@nestjs/common';
import { AdminProfilePhotoService } from './admin-profile-photo.service';
import {
  AdminProfilePhotoQueueInput,
  AdminProfilePhotoQueuePayload,
  AdminProfilePhotoReviewPayload,
  ProfilePhotoReviewResult,
  RejectProfilePhotoInput,
} from './dto/admin-profile-photo.dto';
import { SupabaseAuthGuard } from '../common/guards/supabase-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { ROLE_ID } from '../common/constants/roles.constant';
import { AuthUser, CurrentUser } from '../common/decorators/current-user.decorator';

@Resolver()
@UseGuards(SupabaseAuthGuard, RolesGuard)
@Roles(ROLE_ID.ADMIN, ROLE_ID.SUPER_ADMIN)
export class AdminProfilePhotoResolver {
  constructor(private readonly profilePhotoService: AdminProfilePhotoService) {}

  @Query(() => AdminProfilePhotoQueuePayload, {
    description:
      'Admin only: Caregiver profile photos by review status (default pending, oldest first; ' +
      'approved / rejected newest decision first with reviewer and reason). ' +
      'Includes verified caregivers who changed their photo.',
  })
  async adminProfilePhotoQueue(
    @Args('input') input: AdminProfilePhotoQueueInput,
  ): Promise<AdminProfilePhotoQueuePayload> {
    return this.profilePhotoService.queue(input);
  }

  @Query(() => AdminProfilePhotoReviewPayload, {
    description:
      'Admin only: Pending profile photo, ID card documents and current approved photo ' +
      'with signed URLs, plus profile photo review history. Viewing is written to admin_audit_logs.',
  })
  async adminProfilePhotoReview(
    @Args('caregiverId', { type: () => ID }) caregiverId: string,
    @CurrentUser() admin: AuthUser,
  ): Promise<AdminProfilePhotoReviewPayload> {
    return this.profilePhotoService.reviewDetail(caregiverId, admin.id);
  }

  @Mutation(() => ProfilePhotoReviewResult, {
    description:
      'Admin only: Approve a pending caregiver profile photo. Sets it as the public avatar, ' +
      'records kyc_reviews (profile_photo_approved) and notifies the caregiver. Does not change kycStatus.',
  })
  async approveProfilePhoto(
    @Args('documentId', { type: () => ID }) documentId: string,
    @CurrentUser() admin: AuthUser,
  ): Promise<ProfilePhotoReviewResult> {
    return this.profilePhotoService.approve(documentId, admin);
  }

  @Mutation(() => ProfilePhotoReviewResult, {
    description:
      'Admin only: Reject a pending caregiver profile photo with a reason (required). ' +
      'The current avatar is kept. Records kyc_reviews (profile_photo_rejected) and notifies the caregiver.',
  })
  async rejectProfilePhoto(
    @Args('input') input: RejectProfilePhotoInput,
    @CurrentUser() admin: AuthUser,
  ): Promise<ProfilePhotoReviewResult> {
    return this.profilePhotoService.reject(input, admin);
  }
}
