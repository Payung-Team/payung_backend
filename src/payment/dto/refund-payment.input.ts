import { InputType, Field, ID, Float } from '@nestjs/graphql';
import { IsUUID, IsPositive, IsOptional } from 'class-validator';

@InputType()
export class RefundPaymentInput {
  @Field(() => ID)
  @IsUUID()
  paymentId: string;

  @Field(() => Float, { nullable: true, description: 'จำนวนเงินที่คืน (THB) — ไม่ระบุ = คืนเต็มจำนวน' })
  @IsOptional()
  @IsPositive()
  amount?: number;

  @Field({ nullable: true, description: 'เหตุผลการคืนเงิน' })
  @IsOptional()
  reason?: string;
}
