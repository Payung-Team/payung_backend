import { Args, ID, Query, Resolver } from '@nestjs/graphql';
import { UseGuards } from '@nestjs/common';
import { JobQrService } from './job-qr.service';
import { JobQr } from './entities/job-qr.entity';
import {
  AuthUser,
  CurrentUser,
} from '../../common/decorators/current-user.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { RolesGuard } from '../../common/guards/roles.guard';
import { SupabaseAuthGuard } from '../../common/guards/supabase-auth.guard';
import { ROLE_ID } from '../../common/constants/roles.constant';

/**
 * JobQrResolver — GraphQL ของระบบ QR check-in/out (PYG-434)
 *
 * ตอนนี้มีแค่ query เดียว: jobQr
 * PYG-435 จะมาเพิ่ม mutation scanJobQr (ฝั่งผู้ดูแลสแกน) ในไฟล์แยกของตัวเอง
 * เพราะคนละ role คนละด่านตรวจ — ปนกันในไฟล์เดียวแล้วจะเผลอใช้ guard ผิดตัว
 */
@Resolver(() => JobQr)
export class JobQrResolver {
  constructor(private readonly jobQrService: JobQrService) {}

  @Query(() => JobQr, {
    description:
      'QR ของงาน 1 ใบ สำหรับให้ผู้รับบริการเปิดโชว์ให้ผู้ดูแลสแกน. ★ คืน token ดิบ จึงเปิดให้เฉพาะ patient เจ้าของ booking เท่านั้น — ผู้ดูแลเรียก query นี้ไม่ได้. QR ใบเดียวใช้ได้ทั้งเช็คอินและเช็คเอาท์ ระบบดูจากสถานะปัจจุบันว่าสแกนครั้งต่อไปคือ action ไหน.',
  })
  // ★ สองชั้น: RolesGuard กันไม่ให้ role อื่น (ผู้ดูแล/แอดมิน) เข้าถึง query นี้เลย
  //   ส่วน "เป็นเจ้าของ booking ใบนี้จริงไหม" service เป็นคนตรวจอีกที
  //   (guard รู้แค่ว่าใครเป็น patient แต่ไม่รู้ว่า booking ใบไหนของใคร)
  @UseGuards(SupabaseAuthGuard, RolesGuard)
  @Roles(ROLE_ID.PATIENT) // 1 = patient
  async jobQr(
    @Args('bookingId', { type: () => ID }) bookingId: string,
    @CurrentUser() user: AuthUser,
  ): Promise<JobQr> {
    // ส่ง user.id จาก JWT — ผู้ใช้ปลอมตัวเป็นเจ้าของ booking คนอื่นไม่ได้
    return this.jobQrService.jobQr(user.id, bookingId);
  }
}
