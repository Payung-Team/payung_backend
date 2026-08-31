import { UseGuards } from '@nestjs/common';
import { Args, Mutation, Query, Resolver } from '@nestjs/graphql';
import { ROLE_ID } from '../common/constants/roles.constant';
import {
  AuthUser,
  CurrentUser,
} from '../common/decorators/current-user.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { RolesGuard } from '../common/guards/roles.guard';
import { SupabaseAuthGuard } from '../common/guards/supabase-auth.guard';
import { DisputeService } from './dispute.service';
import { DisputeBooking } from './entities/dispute-booking.entity';
import { DisputeSummaryConnection } from './dto/dispute-summary.type';
import { AdminDisputesInput } from './dto/admin-disputes.input';
import { FlagDisputeInput } from './dto/flag-dispute.input';
import { ResolveDisputeInput } from './dto/resolve-dispute.input';

@Resolver()
@UseGuards(SupabaseAuthGuard)
export class DisputeResolver {
  constructor(private readonly disputeService: DisputeService) {}

  // ── 1. patient flag ───────────────────────────────────────────────────

  @Mutation(() => DisputeBooking, {
    description:
      'Patient flags a dispute on their completed booking. ' +
      'Requires booking.status="completed" and reason length ≥ 20.',
  })
  @UseGuards(RolesGuard)
  @Roles(ROLE_ID.PATIENT)
  async flagBookingDispute(
    @Args('input', { type: () => FlagDisputeInput }) input: FlagDisputeInput,
    @CurrentUser() user: AuthUser,
  ): Promise<DisputeBooking> {
    return this.disputeService.flagBookingDispute(
      input.bookingId,
      input.reason,
      user.id,
    );
  }

  // ── 2. admin queue ────────────────────────────────────────────────────

  @Query(() => DisputeSummaryConnection, {
    description:
      'Admin only: Paginated dispute queue (PYG-316). ' +
      'Filters: disputeStatus, dateFrom/dateTo (filed_at), filedBy, q (id / name / email). ' +
      'Default: all disputes (excludes "none"), sorted sla_asc (most urgent first).',
  })
  @UseGuards(RolesGuard)
  @Roles(ROLE_ID.ADMIN, ROLE_ID.SUPER_ADMIN)
  async adminDisputes(
    @Args('input', { nullable: true, type: () => AdminDisputesInput })
    input?: AdminDisputesInput,
  ): Promise<DisputeSummaryConnection> {
    return this.disputeService.adminDisputes(input ?? {});
  }

  // ── 3. admin resolve ──────────────────────────────────────────────────

  @Mutation(() => DisputeBooking, {
    description:
      'Admin only: Resolve a flagged dispute (no_refund | refund_full | refund_partial). ' +
      'refund_partial requires refundAmount in (0, payment.amount]. ' +
      'refund_full / refund_partial call PaymentService.refundPayment (PYG-286).',
  })
  @UseGuards(RolesGuard)
  @Roles(ROLE_ID.ADMIN, ROLE_ID.SUPER_ADMIN)
  async resolveDispute(
    @Args('input', { type: () => ResolveDisputeInput })
    input: ResolveDisputeInput,
    @CurrentUser() admin: AuthUser,
  ): Promise<DisputeBooking> {
    return this.disputeService.resolveDispute(
      input.bookingId,
      input.decision,
      input.refundAmount,
      input.notes,
      admin,
    );
  }
}
