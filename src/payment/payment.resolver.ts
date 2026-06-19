/**
 * PaymentResolver — GraphQL endpoints ของ payment (PYG-277)
 *
 * ตอนนี้มี endpoint เดียว: paymentHistory — ดึง audit trail ของ payment 1 ใบ
 *
 * ทุก endpoint ต้อง login (SupabaseAuthGuard) และ PaymentService ตรวจ "สิทธิ์ดู"
 * อีกชั้น (ต้องเป็นคู่กรณีหรือ admin) → defense in depth
 */
import { Args, ID, Query, Resolver } from '@nestjs/graphql';
import { UseGuards } from '@nestjs/common';
import { PaymentService } from './payment.service';
import { PaymentStatusHistory } from './entities/payment-status-history.entity';
import { SupabaseAuthGuard } from '../common/guards/supabase-auth.guard';
import {
  CurrentUser,
  AuthUser,
} from '../common/decorators/current-user.decorator';

@Resolver(() => PaymentStatusHistory)
@UseGuards(SupabaseAuthGuard) // ทุก endpoint ใน resolver นี้ต้อง login ก่อน
export class PaymentResolver {
  constructor(private readonly paymentService: PaymentService) {}

  /**
   * paymentHistory — ไทม์ไลน์การเปลี่ยนสถานะของ payment (เก่า → ใหม่)
   *
   * ใช้โดย: หน้า admin / หน้า detail การชำระเงิน เพื่อดูว่า payment ผ่านอะไรมาบ้าง
   *
   * @param paymentId - UUID ของ payment
   */
  @Query(() => [PaymentStatusHistory], {
    description: 'ประวัติการเปลี่ยนสถานะของ payment (เรียงเก่า → ใหม่)',
  })
  async paymentHistory(
    @CurrentUser() user: AuthUser,
    @Args('paymentId', { type: () => ID }) paymentId: string,
  ): Promise<PaymentStatusHistory[]> {
    return this.paymentService.getHistory(paymentId, user);
  }
}
