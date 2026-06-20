import { Args, ID, Mutation, Query, Resolver } from '@nestjs/graphql';
import { UseGuards } from '@nestjs/common';
import { BookingService } from './booking.service';
import { BookingHistoryInput } from './dto/booking-history.input';
import { BookingListResponse, BookingSummary } from './dto/booking-summary.types';
import { AuthUser, CurrentUser } from '../common/decorators/current-user.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { RolesGuard } from '../common/guards/roles.guard';
import { SupabaseAuthGuard } from '../common/guards/supabase-auth.guard';
import { ROLE_ID } from '../common/constants/roles.constant';

@Resolver()
@UseGuards(SupabaseAuthGuard, RolesGuard)
@Roles(ROLE_ID.PATIENT)
export class BookingResolver {
  constructor(private readonly bookingService: BookingService) {}

  @Mutation(() => BookingSummary, {
    description: 'Patient confirms a booking that has been accepted by the caregiver.',
  })
  async confirmBooking(
    @Args('bookingId', { type: () => ID }) bookingId: string,
    @CurrentUser() user: AuthUser,
  ): Promise<BookingSummary> {
    return this.bookingService.confirmBooking(bookingId, user.id);
  }

  @Query(() => BookingSummary, {
    description: 'Returns a single booking by ID for the authenticated patient.',
  })
  async myBooking(
    @Args('id', { type: () => ID }) id: string,
    @CurrentUser() user: AuthUser,
  ): Promise<BookingSummary> {
    return this.bookingService.myBookingById(id, user.id);
  }

  @Query(() => BookingListResponse, {
    description: 'Returns the patient\'s full booking history, optionally filtered by status, newest first.',
  })
  async myBookingHistory(
    @Args('input', { nullable: true, defaultValue: {} }) input: BookingHistoryInput,
    @CurrentUser() user: AuthUser,
  ): Promise<BookingListResponse> {
    return this.bookingService.myBookingHistory(user.id, input);
  }
}
