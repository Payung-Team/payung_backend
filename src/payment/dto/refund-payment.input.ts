/**
 * RefundPaymentInput — admin refund (PYG-286)
 *
 * - paymentId : payment ที่ต้องการคืนเงิน (ต้องอยู่สถานะ "captured")
 * - amount    : optional. ไม่ระบุ = คืนเต็มจำนวน. ระบุ = partial refund
 *               ต้องอยู่ในช่วง (0, payment.amount] — service ตรวจอีกชั้น
 * - reason    : optional บันทึกใน audit history + payment.metadata
 */
import { Field, Float, ID, InputType } from '@nestjs/graphql';
import { IsNotEmpty, IsOptional, IsPositive, IsString, IsUUID, MaxLength } from 'class-validator';

@InputType()
export class RefundPaymentInput {
  @Field(() => ID, { description: 'UUID ของ payment ที่ต้องการคืนเงิน' })
  @IsUUID('4')
  paymentId!: string;

  @Field(() => Float, {
    nullable: true,
    description: 'จำนวนเงินที่คืน (THB) — ไม่ระบุ = คืนเต็มจำนวน, ระบุ = partial refund',
  })
  @IsOptional()
  @IsPositive()
  amount?: number;

  @Field({ nullable: true, description: 'เหตุผลการคืนเงิน (audit)' })
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(500)
  reason?: string;
}
