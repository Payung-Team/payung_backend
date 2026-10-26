import {
  Controller,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { SupabaseHttpAuthGuard } from '../common/guards/supabase-http-auth.guard';
import {
  AuthUser,
  CurrentHttpUser,
} from '../common/decorators/current-user.decorator';
import { PROFILE_PHOTO_MAX_BYTES } from '../identity/kyc/profile-photo.constants';
import {
  FamilyGroupAvatarResult,
  FamilyGroupAvatarService,
} from './family-group-avatar.service';

/**
 * POST /api/v1/family-groups/:groupId/avatar — multipart field 'photo' (JPEG ที่ FE ครอปแล้ว)
 *
 * REST ไม่ใช่ GraphQL เพราะต้องรับไฟล์ (แพตเทิร์นเดียวกับ POST /api/v1/profile/photo)
 * ลบรูปใช้ mutation removeFamilyGroupAvatar แทน — ได้ FamilyGroup กลับไปอัปเดต cache ของ FE ตรง ๆ
 *
 * ลำดับด่าน: guard (401/403 บัญชีถูกระงับ) → multer limits (413) → UUID (400)
 *   → service (403 ไม่ใช่เจ้าของ / 400 ไม่มีไฟล์ / 415 ไม่ใช่ JPEG / 500)
 */
@Controller('api/v1/family-groups')
@UseGuards(SupabaseHttpAuthGuard)
export class FamilyGroupAvatarController {
  constructor(private readonly groupAvatarService: FamilyGroupAvatarService) {}

  @Post(':groupId/avatar')
  @HttpCode(HttpStatus.OK)
  @UseInterceptors(
    FileInterceptor('photo', {
      limits: { fileSize: PROFILE_PHOTO_MAX_BYTES, files: 1, fields: 0 },
    }),
  )
  upload(
    @Param('groupId', new ParseUUIDPipe()) groupId: string,
    @UploadedFile() photo: Express.Multer.File | undefined,
    @CurrentHttpUser() user: AuthUser,
  ): Promise<FamilyGroupAvatarResult> {
    return this.groupAvatarService.upload(user.id, groupId, photo);
  }
}
