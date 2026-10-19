import {
  Controller,
  HttpCode,
  HttpStatus,
  Post,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import {
  ProfilePhotoService,
  ProfilePhotoResult,
} from './profile-photo.service';
import { PROFILE_PHOTO_MAX_BYTES } from './profile-photo.constants';
import { SupabaseHttpAuthGuard } from '../../common/guards/supabase-http-auth.guard';
import {
  AuthUser,
  CurrentHttpUser,
} from '../../common/decorators/current-user.decorator';

/**
 * Profile Photo REST Controller (PYG-507)
 *
 * POST /api/v1/profile/photo — multipart field 'photo' (JPEG)
 *
 * ทำไมเป็น REST ไม่ใช่ GraphQL: ต้องรับไฟล์ (แพตเทิร์นเดียวกับ care log ของ PYG-466)
 * ทุก role เรียกได้ — service เป็นคนแยกว่าผู้ดูแลต้องเข้าคิวรีวิว ส่วน role อื่นเปลี่ยนรูปได้ทันที
 *
 * ลำดับด่าน: guard (401) → multer limits (413 ไฟล์ใหญ่ / 400 ไฟล์เกิน 1) → service (415/400/500)
 */
@Controller('api/v1/profile/photo')
@UseGuards(SupabaseHttpAuthGuard)
export class ProfilePhotoController {
  constructor(private readonly profilePhotoService: ProfilePhotoService) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @UseInterceptors(
    FileInterceptor('photo', {
      limits: { fileSize: PROFILE_PHOTO_MAX_BYTES, files: 1, fields: 0 },
    }),
  )
  upload(
    @UploadedFile() photo: Express.Multer.File | undefined,
    @CurrentHttpUser() user: AuthUser,
  ): Promise<ProfilePhotoResult> {
    return this.profilePhotoService.upload(user.id, user.role, photo);
  }
}
