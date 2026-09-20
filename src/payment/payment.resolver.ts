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
import { RefundPaymentInput } from './dto/refund-payment.input';

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

  // ── PYG-278: PromptPay polling fallback ──────────────────────────────────

  @Query(() => Payment, {
    nullable: true,
    description:
      'ดู payment ของ booking — สำหรับ FE PromptPay polling (เปิดให้ patient/caregiver/admin). ' +
      'ถ้า payment ยังเป็น pending + paymentMethod=promptpay จะ retrieve charge จาก Omise สด ๆ ' +
      'แล้ว reconcile ถ้า user จ่ายแล้ว (กันเคส webhook เลทหรือหาย).',
  })
  async paymentByBooking(
    @Args('bookingId', { type: () => ID }) bookingId: string,
    @CurrentUser() user: AuthUser,
  ): Promise<Payment | null> {
    return this.paymentService.paymentByBooking(bookingId, user);
  }

  // ── PYG-266: admin-only — real Omise Transfer (replaces PYG-282 manual mark) ────

  @Mutation(() => Payment, {
    description:
      'Admin only: Transfer a captured payment to the caregiver via a real Omise Transfer, ' +
      'minus the platform fee. Requires paymentStatus = "captured" and a verified payout account.',
  })
  @UseGuards(RolesGuard)
  @Roles(ROLE_ID.ADMIN, ROLE_ID.SUPER_ADMIN)
  async transferPaymentToCaregiver(
    @Args('bookingId', { type: () => ID }) bookingId: string,
    @CurrentUser() admin: AuthUser,
  ): Promise<Payment> {
    return this.paymentService.transferPaymentToCaregiver(bookingId, admin);
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

  // ── PYG-286: admin refund (full / partial) ──────────────────────────────

  @Mutation(() => Payment, {
    description:
      'Admin only: Refund a captured payment (full or partial). ' +
      'amount omitted = full refund. amount specified must be in (0, payment.amount]. ' +
      'Uses Omise-Idempotency-Key to prevent double-refund races.',
  })
  @UseGuards(RolesGuard)
  @Roles(ROLE_ID.ADMIN, ROLE_ID.SUPER_ADMIN)
  async refundPayment(
    @Args('input') input: RefundPaymentInput,
    @CurrentUser() admin: AuthUser,
  ): Promise<Payment> {
    return this.paymentService.refundPayment(input, admin);
  }
}
