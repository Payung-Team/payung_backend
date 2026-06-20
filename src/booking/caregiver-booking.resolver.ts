import { Args, ID, Mutation, Query, Resolver } from '@nestjs/graphql';
import { UseGuards } from '@nestjs/common';
import { CaregiverBookingService } from './caregiver-booking.service';
import {
  CaregiverBookingListResponse,
  CaregiverBookingSummary,
} from './dto/caregiver-booking.types';
import { CaregiverBookingsInput } from './dto/caregiver-bookings.input';
import { CaregiverBookingHistoryInput } from './dto/caregiver-booking-history.input';
import { DeclineBookingInput } from './dto/decline-booking.input';
import { CancelAcceptanceInput } from './dto/cancel-acceptance.input';
import { AuthUser, CurrentUser } from '../common/decorators/current-user.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { RolesGuard } from '../common/guards/roles.guard';
import { SupabaseAuthGuard } from '../common/guards/supabase-auth.guard';
import { ROLE_ID } from '../common/constants/roles.constant';

/**
 * CaregiverBookingResolver (PYG-206)
 *
 * GraphQL ฝั่ง "caregiver" สำหรับจัดการ booking ที่ตัวเองถูก assign:
 * ดูคำขอเข้ามา / รับ / ปฏิเสธ / ดูงานที่กำลังจะถึง / ประวัติ / ลูกค้าประจำ
 *
 * หมายเหตุ: ทุก operation จำกัดเฉพาะ role=CAREGIVER (guard ระดับ class)
 *           แยก resolver ออกจาก BookingResolver (ที่เป็น role=PATIENT)
 *           เพราะ @Roles กำหนดได้ครั้งเดียวต่อ class
 */
@Resolver()
@UseGuards(SupabaseAuthGuard, RolesGuard)
@Roles(ROLE_ID.CAREGIVER)
export class CaregiverBookingResolver {
  constructor(private readonly service: CaregiverBookingService) {}

  // ─── Queries ──────────────────────────────────────────────────────────────

  @Query(() => CaregiverBookingListResponse, {
    description:
      'Caregiver bookings filtered by status (pending=new requests, accepted=awaiting patient, confirmed+upcoming=active jobs).',
  })
  async caregiverBookings(
    @Args('input') input: CaregiverBookingsInput,
    @CurrentUser() user: AuthUser,
  ): Promise<CaregiverBookingListResponse> {
    return this.service.caregiverBookings(user.id, input);
  }

  @Query(() => CaregiverBookingListResponse, {
    description:
      "Caregiver's full booking history (all statuses), optionally filtered by status and date range, newest first.",
  })
  async caregiverBookingHistory(
    @Args('input', { nullable: true, defaultValue: {} })
    input: CaregiverBookingHistoryInput,
    @CurrentUser() user: AuthUser,
  ): Promise<CaregiverBookingListResponse> {
    return this.service.caregiverBookingHistory(user.id, input);
  }

  // ─── Mutations ──────────────────────────────────────────────────────────────

  @Mutation(() => CaregiverBookingSummary, {
    description: 'Caregiver marks a confirmed booking as completed (confirmed → completed).',
  })
  async completeBooking(
    @Args('bookingId', { type: () => ID }) bookingId: string,
    @CurrentUser() user: AuthUser,
  ): Promise<CaregiverBookingSummary> {
    return this.service.completeBooking(user.id, bookingId);
  }

  @Mutation(() => CaregiverBookingSummary, {
    description: 'Caregiver accepts a pending booking request (pending → accepted).',
  })
  async acceptBooking(
    @Args('bookingId', { type: () => ID }) bookingId: string,
    @CurrentUser() user: AuthUser,
  ): Promise<CaregiverBookingSummary> {
    return this.service.acceptBooking(user.id, bookingId);
  }

  @Mutation(() => CaregiverBookingSummary, {
    description:
      'Caregiver declines a pending booking request with a required reason (pending → rejected).',
  })
  async declineBooking(
    @Args('input') input: DeclineBookingInput,
    @CurrentUser() user: AuthUser,
  ): Promise<CaregiverBookingSummary> {
    return this.service.declineBooking(user.id, input);
  }

  @Mutation(() => CaregiverBookingSummary, {
    description:
      'Caregiver cancels a previously accepted booking before patient confirmation, with a required reason (accepted → rejected).',
  })
  async cancelAcceptance(
    @Args('input') input: CancelAcceptanceInput,
    @CurrentUser() user: AuthUser,
  ): Promise<CaregiverBookingSummary> {
    return this.service.cancelAcceptance(user.id, input);
  }
}
