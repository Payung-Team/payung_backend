import { Args, Mutation, Resolver } from '@nestjs/graphql';
import { UseGuards } from '@nestjs/common';
import { MonitoringService } from './monitoring.service';
import { CheckInInput } from './dto/check-in.input';
import { JobEvent } from './entities/job-event.entity';
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
}
