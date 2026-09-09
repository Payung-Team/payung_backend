import { Args, ID, Mutation, Query, Resolver } from '@nestjs/graphql';
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
 * ไฟล์นี้เป็นของ "ฝั่งผู้รับบริการ" ล้วน ๆ — ทุก operation ต้องเป็น @Roles(PATIENT)
 *   · jobQr        (query)    — ขอ QR ของงานตัวเองมาแสดง
 *   · rotateJobQr  (mutation) — ออก QR ใบใหม่ ใบเก่าตายทันที (PYG-437)
 *
 * ★ mutation scanJobQr (ฝั่งผู้ดูแลสแกน) อยู่ในไฟล์แยกของตัวเองโดยตั้งใจ
 *   เพราะคนละ role คนละด่านตรวจ — ปนกันในไฟล์เดียวแล้วจะเผลอใช้ guard ผิดตัว
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

  // ══════════════════════════════════════════════════════════════════════
  // PYG-437 — ออก QR ใบใหม่
  // ══════════════════════════════════════════════════════════════════════

  @Mutation(() => JobQr, {
    description:
      'ออก QR ใบใหม่ให้งานนี้ — ★ ใบเก่าใช้ไม่ได้ทันที. ใช้ตอน QR หลุด (ถูกถ่ายรูป/ส่งต่อ) หรือผู้ดูแลสแกนไม่ผ่านโดยไม่ทราบสาเหตุ. เฉพาะ patient เจ้าของงานเท่านั้น. งานที่ปิดไปแล้วออกใหม่ไม่ได้ (ไม่เหลือ action ให้สแกน).',
  })
  // ★ guard ชุดเดียวกับ query jobQr เป๊ะ ๆ — สองทางนี้เข้าถึงของลับก้อนเดียวกัน
  //   ถ้าวันหนึ่งมีการแก้ guard ของอันใดอันหนึ่ง ต้องแก้อีกอันพร้อมกันเสมอ
  @UseGuards(SupabaseAuthGuard, RolesGuard)
  @Roles(ROLE_ID.PATIENT) // 1 = patient
  async rotateJobQr(
    @Args('bookingId', { type: () => ID }) bookingId: string,
    @CurrentUser() user: AuthUser,
  ): Promise<JobQr> {
    return this.jobQrService.rotateJobQr(user.id, bookingId);
  }
}
