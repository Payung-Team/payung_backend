import {
  Body,
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
import { CareLogService } from './care-log.service';
import { CreateCareLogDto } from './dto/create-care-log.dto';
import { CareLog } from './entities/care-log.entity';
import { CARE_LOG_PHOTO_MAX_BYTES } from './monitoring.constants';
import { SupabaseHttpAuthGuard } from '../common/guards/supabase-http-auth.guard';
import { HttpRolesGuard } from '../common/guards/http-roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import {
  CurrentHttpUser,
  AuthUser,
} from '../common/decorators/current-user.decorator';
import { ROLE_ID } from '../common/constants/roles.constant';

/**
 * Care Log REST Controller (PYG-466)
 *
 * POST /api/v1/monitoring/bookings/:bookingId/care-logs — multipart: category, body, deviceTs, photo?
 *
 * ทำไมเป็น REST ไม่ใช่ GraphQL: ต้องรับไฟล์ — เดิม client อัปโหลดเข้า job-evidence เองแล้วส่ง path มา
 * การ์ดนี้ย้ายการอัปโหลดมาที่ backend (bucket care-log-images) client แตะ storage ไม่ได้อีก
 *
 * ลำดับที่ด่านทำงานจริง (สำคัญกับ error contract ของ FE):
 *   guard (401/403) → multer limits (413/400) → ValidationPipe + ParseUUIDPipe (400) → service
 * guard รันก่อน interceptor เสมอ → คนไม่มี token ส่งไฟล์เข้า memory ไม่ได้
 */
@Controller('api/v1/monitoring/bookings/:bookingId/care-logs')
@UseGuards(SupabaseHttpAuthGuard, HttpRolesGuard)
@Roles(ROLE_ID.CAREGIVER)
export class CareLogController {
  constructor(private readonly careLogService: CareLogService) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @UseInterceptors(
    // ตัดขนาดตั้งแต่ชั้นรับ ไม่ใช่หลังได้ buffer — error ของ multer ปล่อยให้ Nest แปลงเอง (ห้าม map ใหม่)
    //   ไฟล์ใหญ่เกิน → 413, เกิน 1 ไฟล์ → 400, field เกิน → 400
    FileInterceptor('photo', {
      limits: {
        fileSize: CARE_LOG_PHOTO_MAX_BYTES,
        files: 1,
        fields: 3, // category, body, deviceTs
      },
    }),
  )
  create(
    @Param('bookingId', new ParseUUIDPipe()) bookingId: string,
    @Body() dto: CreateCareLogDto,
    @UploadedFile() photo: Express.Multer.File | undefined,
    @CurrentHttpUser() user: AuthUser,
  ): Promise<CareLog> {
    return this.careLogService.createCareLog(user.id, bookingId, dto, photo);
  }
}
