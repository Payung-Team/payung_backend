/**
 * CompleteBookingResolver — GraphQL mutation `completeBooking` (PYG-281)
 *
 * เปิดให้ทั้ง "patient" และ "caregiver" ของ booking เรียกได้ (role gating ระดับ class)
 * ส่วนการตรวจ "เป็นเจ้าของ booking จริงไหม" อยู่ใน service (ownership check)
 *
 * mutation นี้แทนที่ของเดิม (caregiver-only placeholder ใน CaregiverBookingResolver)
 * เพราะตอนนี้การจบงานต้อง capture เงินจริงด้วย → รวมไว้ที่ payment module ที่เดียว
 */
import { Args, ID, Mutation, Resolver } from '@nestjs/graphql';
import { UseGuards } from '@nestjs/common';
import { CompleteBookingService } from './complete-booking.service';
import { CompleteBookingResult } from './dto/complete-booking-result.type';
import {
  AuthUser,
  CurrentUser,
} from '../common/decorators/current-user.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { RolesGuard } from '../common/guards/roles.guard';
import { SupabaseAuthGuard } from '../common/guards/supabase-auth.guard';
import { ROLE_ID } from '../common/constants/roles.constant';

@Resolver()
@UseGuards(SupabaseAuthGuard, RolesGuard)
@Roles(ROLE_ID.PATIENT, ROLE_ID.CAREGIVER)
export class CompleteBookingResolver {
  constructor(private readonly service: CompleteBookingService) {}

  @Mutation(() => CompleteBookingResult, {
    description:
      'Patient or caregiver completes a confirmed booking: captures the held charge (payment held → captured) and marks the booking completed (confirmed → completed).',
  })
  async completeBooking(
    @Args('bookingId', { type: () => ID }) bookingId: string,
    @CurrentUser() user: AuthUser,
  ): Promise<CompleteBookingResult> {
    return this.service.completeBooking(user, bookingId);
  }
}
