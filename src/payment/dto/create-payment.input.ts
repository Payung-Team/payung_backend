import { InputType, Field, ID } from '@nestjs/graphql';
import { IsUUID, IsNotEmpty, IsString, IsIn, IsOptional, ValidateIf } from 'class-validator';

@InputType()
export class CreatePaymentInput {
  @Field(() => ID, { description: 'UUID ของ booking ที่ต้องการชำระเงิน (ต้องมีสถานะ accepted)' })
  @IsUUID('4')
  bookingId: string;

  @Field({ defaultValue: 'credit_card', description: 'วิธีการชำระเงิน: credit_card | promptpay' })
  @IsIn(['credit_card', 'promptpay'])
  paymentMethod: string = 'credit_card';

  @Field({ nullable: true, description: 'Omise card token (tokn_...) — จำเป็นสำหรับ credit_card เท่านั้น' })
  @ValidateIf((o: CreatePaymentInput) => o.paymentMethod === 'credit_card')
  @IsString()
  @IsNotEmpty()
  omiseToken?: string;
}
