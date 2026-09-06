import { Args, Mutation, Resolver } from '@nestjs/graphql';
import { UseGuards } from '@nestjs/common';
import { JobScanService } from './job-scan.service';
import { ScanJobQrInput } from './dto/scan-job-qr.input';
import { JobScanResult } from './entities/job-scan-result.entity';
import {
  AuthUser,
  CurrentUser,
} from '../../common/decorators/current-user.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { RolesGuard } from '../../common/guards/roles.guard';
import { SupabaseAuthGuard } from '../../common/guards/supabase-auth.guard';
import { ROLE_ID } from '../../common/constants/roles.constant';

/**
 * JobScanResolver — GraphQL ของการสแกน QR (PYG-435)
 *
 * แยกไฟล์จาก JobQrResolver เพราะคนละฝั่งกันคนละคน:
 *   jobQr     → ผู้รับบริการ (role 1) ดู QR ของตัวเอง
 *   scanJobQr → ผู้ดูแล      (role 2) สแกน QR ของคนอื่น
 * เอามารวมไฟล์เดียวแล้ว @Roles จะสลับไปมาในไฟล์เดียว ซึ่งอ่านพลาดง่ายมาก
 */
@Resolver(() => JobScanResult)
export class JobScanResolver {
  constructor(private readonly jobScanService: JobScanService) {}

  @Mutation(() => JobScanResult, {
    description:
      'ผู้ดูแลสแกน QR ของงานเพื่อเริ่มหรือจบงาน. ★ สแกนครั้งแรก = เช็คอิน, ครั้งที่สอง = เช็คเอาท์ — ผู้เรียก "ไม่ได้เลือก" ว่าจะทำอะไร สถานะของ QR เป็นตัวตัดสิน. ★ การสแกนที่ถูกปฏิเสธจะ "ไม่ throw error" แต่คืน ok=false พร้อมรหัสเหตุผลใน result (ทุกครั้งถูกบันทึกไว้เสมอ ทั้งสำเร็จและล้มเหลว).',
  })
  @UseGuards(SupabaseAuthGuard, RolesGuard)
  @Roles(ROLE_ID.CAREGIVER) // 2 = caregiver — คนอื่นสแกนไม่ได้เลย
  async scanJobQr(
    @Args('input') input: ScanJobQrInput,
    @CurrentUser() user: AuthUser,
  ): Promise<JobScanResult> {
    // ส่ง user.id จาก JWT — ผู้ใช้อ้างว่าเป็นผู้ดูแลคนอื่นผ่าน input ไม่ได้
    return this.jobScanService.scanJobQr(user.id, input);
  }
}
