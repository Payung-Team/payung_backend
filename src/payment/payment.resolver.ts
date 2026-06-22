import { Args, ID, Mutation, Query, Resolver } from '@nestjs/graphql';
import { UseGuards } from '@nestjs/common';
import { SupabaseAuthGuard } from '../common/guards/supabase-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { ROLE_ID } from '../common/constants/roles.constant';
import { CurrentUser, AuthUser } from '../common/decorators/current-user.decorator';
import { PaymentService } from './payment.service';
import { PaymentStatusHistory } from './entities/payment-status-history.entity';
import { Payment } from './dto/payment.type';
import { PaymentConnection } from './dto/payment-connection.type';
import { AdminPaymentsInput } from './dto/admin-payments.input';
import { CreatePaymentInput } from './dto/create-payment.input';

@Resolver()
@UseGuards(SupabaseAuthGuard)
export class PaymentResolver {
  constructor(private readonly paymentService: PaymentService) {}

  // ── PYG-277: open to authenticated users (service enforces party/admin check) ──

  @Query(() => [PaymentStatusHistory], {
    description: 'ประวัติการเปลี่ยนสถานะของ payment (เรียงเก่า → ใหม่)',
  })
  async paymentHistory(
    @CurrentUser() user: AuthUser,
    @Args('paymentId', { type: () => ID }) paymentId: string,
  ): Promise<PaymentStatusHistory[]> {
    return this.paymentService.getHistory(paymentId, user);
  }

  // ── PYG-281: Authorize Payment ───────────────────────────────────────────

  @Mutation(() => Payment)
  @UseGuards(RolesGuard)
  @Roles(ROLE_ID.PATIENT)
  async createPayment(
    @Args('input') input: CreatePaymentInput,
    @CurrentUser() user: AuthUser,
  ): Promise<Payment> {
    return this.paymentService.createPayment(input, user);
  }

  // ── PYG-282: admin-only ───────────────────────────────────────────────────

  @Mutation(() => Payment, {
    description:
      'Admin only: Mark a captured payment as transferred to the caregiver. ' +
      'Requires paymentStatus = "captured". Uses FSM for atomic status update + audit history.',
  })
  @UseGuards(RolesGuard)
  @Roles(ROLE_ID.ADMIN, ROLE_ID.SUPER_ADMIN)
  async markPaymentTransferred(
    @Args('paymentId', { type: () => ID }) paymentId: string,
    @Args('transferRef') transferRef: string,
    @Args('notes', { nullable: true }) notes?: string,
    @CurrentUser() admin?: AuthUser,
  ): Promise<Payment> {
    return this.paymentService.markPaymentTransferred(
      paymentId,
      transferRef,
      notes,
      admin!.id,
    );
  }

  @Query(() => PaymentConnection, {
    description:
      'Admin only: Paginated payments list filtered by status (default: captured = pending transfer). ' +
      'Sorted oldest-first (FIFO).',
  })
  @UseGuards(RolesGuard)
  @Roles(ROLE_ID.ADMIN, ROLE_ID.SUPER_ADMIN)
  async adminPayments(
    @Args('input', { nullable: true, type: () => AdminPaymentsInput })
    input?: AdminPaymentsInput,
  ): Promise<PaymentConnection> {
    return this.paymentService.adminPayments(input ?? {});
  }
}
