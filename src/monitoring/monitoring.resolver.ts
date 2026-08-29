import { Args, ID, Mutation, Query, Resolver } from '@nestjs/graphql';
import { UseGuards } from '@nestjs/common';
import { MonitoringService } from './monitoring.service';
import { CheckInInput } from './dto/check-in.input';
import { CheckOutInput } from './dto/check-out.input';
import { JobEvent } from './entities/job-event.entity';
import { ProofOfWorkSummary } from './entities/proof-of-work.entity';
import {
  AuthUser,
  CurrentUser,
} from '../common/decorators/current-user.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { RolesGuard } from '../common/guards/roles.guard';
import { SupabaseAuthGuard } from '../common/guards/supabase-auth.guard';
import { ROLE_ID } from '../common/constants/roles.constant';

/**
 * MonitoringResolver — GraphQL ของระบบ proof-of-work (PYG-352)
 *
 * ตอนนี้มีแค่ checkInBooking
 * PYG-358 จะมาเพิ่ม checkOutBooking + query proofOfWork ในไฟล์เดียวกันนี้
 */
@Resolver(() => JobEvent)
export class MonitoringResolver {
  constructor(private readonly monitoringService: MonitoringService) {}

  @Mutation(() => JobEvent, {
    description:
      'ผู้ดูแลเช็คอินเพื่อเริ่มงาน (confirmed → in_progress). ★ GPS ไม่เคยทำให้ล้มเหลว — พิกัดเพี้ยนหรือไม่มีพิกัดเลยก็เช็คอินได้ ระบบแค่ติดธงไว้ให้แอดมินดู. กดซ้ำได้ ไม่ error และไม่เกิดแถวใหม่.',
  })
  @UseGuards(SupabaseAuthGuard, RolesGuard)
  @Roles(ROLE_ID.CAREGIVER) // 2 = caregiver
  async checkInBooking(
    @Args('input') input: CheckInInput,
    @CurrentUser() user: AuthUser,
  ): Promise<JobEvent> {
    // ส่ง user.id จาก JWT — ผู้ใช้ปลอม caregiverId ผ่าน input ไม่ได้
    return this.monitoringService.checkInBooking(user.id, input);
  }

  @Mutation(() => JobEvent, {
    description:
      'ผู้ดูแลเช็คเอาท์เพื่อ "ปิดงาน" (in_progress → awaiting_release ถ้าไม่มีธง, → needs_review ถ้ามี). ★ ผู้รับบริการไม่ต้องกดยืนยันอะไรอีก. แนบบันทึกและรูปได้ 1 รูป (ต้องเป็นไฟล์ใน bucket ของเราเท่านั้น). การ์ดนี้ไม่แตะเงิน — การ capture เป็นงานของ Epic 2.',
  })
  @UseGuards(SupabaseAuthGuard, RolesGuard)
  @Roles(ROLE_ID.CAREGIVER)
  async checkOutBooking(
    @Args('input') input: CheckOutInput,
    @CurrentUser() user: AuthUser,
  ): Promise<JobEvent> {
    return this.monitoringService.checkOutBooking(user.id, input);
  }

  @Query(() => ProofOfWorkSummary, {
    description:
      'สรุปหลักฐานการทำงานของงาน 1 ใบ — เป็น "แหล่งความจริงเดียว" ที่ระบบเงินอ่านก่อนตัดสินใจโอน. เปิดให้เจ้าของงานทั้งสองฝ่ายและแอดมิน.',
  })
  @UseGuards(SupabaseAuthGuard, RolesGuard)
  // 1=patient 2=caregiver 3=admin — service ตรวจซ้ำอีกชั้นว่าเป็นคู่กรณีของงานนี้จริง
  @Roles(ROLE_ID.PATIENT, ROLE_ID.CAREGIVER, ROLE_ID.ADMIN)
  async proofOfWork(
    @Args('bookingId', { type: () => ID }) bookingId: string,
    @CurrentUser() user: AuthUser,
  ): Promise<ProofOfWorkSummary> {
    return this.monitoringService.proofOfWork(user.id, user.role, bookingId);
  }
}
