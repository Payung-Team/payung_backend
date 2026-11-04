import { UseGuards } from '@nestjs/common';
import { Args, ID, Query, Resolver } from '@nestjs/graphql';
import { SupabaseAuthGuard } from '../common/guards/supabase-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { ROLE_ID } from '../common/constants/roles.constant';
import { AdminBookingsService } from './admin-bookings.service';
import { AdminBookingConnection, AdminBookingDetail, AdminBookingsInput } from './dto/admin-bookings.dto';

@Resolver()
@UseGuards(SupabaseAuthGuard, RolesGuard)
@Roles(ROLE_ID.ADMIN, ROLE_ID.SUPER_ADMIN)
export class AdminBookingsResolver {
  constructor(private readonly service: AdminBookingsService) {}

  @Query(() => AdminBookingConnection, {
    description: 'Admin only: รายการ booking ทั้งระบบ พร้อมผู้จอง/ผู้ดูแล — กรองสถานะ + ค้นหา, ใหม่ → เก่า',
  })
  adminBookings(
    @Args('input', { nullable: true, type: () => AdminBookingsInput }) input?: AdminBookingsInput,
  ): Promise<AdminBookingConnection> {
    return this.service.list(input ?? {});
  }

  @Query(() => AdminBookingDetail, { description: 'Admin only: รายละเอียด booking + การชำระเงิน + ประวัติสถานะ' })
  adminBookingDetail(@Args('id', { type: () => ID }) id: string): Promise<AdminBookingDetail> {
    return this.service.detail(id);
  }
}
