import { Args, ID, Mutation, Query, Resolver } from '@nestjs/graphql';
import { UseGuards } from '@nestjs/common';
import { SupabaseAuthGuard } from '../common/guards/supabase-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { ROLE_ID } from '../common/constants/roles.constant';
import {
  AuthUser,
  CurrentUser,
} from '../common/decorators/current-user.decorator';
import { MatchingService } from './matching.service';
import {
  BookingCaregiverSelection,
  BookingMatchReport,
  EligibleCaregivers,
} from './matching.types';
@Resolver()
@UseGuards(SupabaseAuthGuard, RolesGuard)
export class MatchingResolver {
  constructor(private readonly service: MatchingService) {}
  @Query(() => EligibleCaregivers)
  @Roles(ROLE_ID.PATIENT)
  eligibleCaregivers(
    @Args('bookingId', { type: () => ID }) bookingId: string,
    @CurrentUser() actor: AuthUser,
  ) {
    return this.service.eligibleCaregivers(bookingId, actor);
  }
  @Query(() => BookingMatchReport)
  @Roles(ROLE_ID.ADMIN, ROLE_ID.SUPER_ADMIN)
  bookingMatchReport(
    @Args('bookingId', { type: () => ID }) bookingId: string,
    @CurrentUser() actor: AuthUser,
  ) {
    return this.service.bookingMatchReport(bookingId, actor);
  }
  @Mutation(() => BookingCaregiverSelection)
  @Roles(ROLE_ID.PATIENT)
  selectBookingCaregiver(
    @Args('bookingId', { type: () => ID }) bookingId: string,
    @Args('caregiverId', { type: () => ID }) caregiverId: string,
    @CurrentUser() actor: AuthUser,
  ) {
    return this.service.selectBookingCaregiver(bookingId, caregiverId, actor);
  }
}
