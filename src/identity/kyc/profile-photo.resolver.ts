/**
 * ProfilePhotoResolver — ผู้ดูแลถามสถานะรีวิวรูปโปรไฟล์ของตัวเอง (PYG-488)
 *
 * อัปโหลดยังเป็น REST (POST /api/v1/profile/photo) เพราะ GraphQL รับไฟล์ไม่ได้
 * แต่สถานะอ่านผ่าน GraphQL เหมือนข้อมูลโปรไฟล์อื่น ๆ
 */
import { Query, Resolver } from '@nestjs/graphql';
import { UseGuards } from '@nestjs/common';
import { ProfilePhotoService } from './profile-photo.service';
import { MyProfilePhotoReview } from './entities/my-profile-photo-review.entity';
import { SupabaseAuthGuard } from '../../common/guards/supabase-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { ROLE_ID } from '../../common/constants/roles.constant';
import { AuthUser, CurrentUser } from '../../common/decorators/current-user.decorator';

@Resolver()
@UseGuards(SupabaseAuthGuard, RolesGuard)
export class ProfilePhotoResolver {
  constructor(private readonly profilePhotoService: ProfilePhotoService) {}

  @Query(() => MyProfilePhotoReview, {
    nullable: true,
    description:
      'Caregiver only: review status of my latest uploaded profile photo ' +
      '(pending / approved / rejected + reason). null if none uploaded yet.',
  })
  @Roles(ROLE_ID.CAREGIVER)
  myProfilePhotoReview(@CurrentUser() user: AuthUser): Promise<MyProfilePhotoReview | null> {
    return this.profilePhotoService.myReview(user.id);
  }
}
