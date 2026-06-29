import { InputType, Field, ID } from '@nestjs/graphql';
import { IsUUID, IsNotEmpty, IsString, IsIn, IsOptional, ValidateIf } from 'class-validator';

@InputType()
export class CreatePaymentInput {
  @Field()
  @IsString()
  @IsNotEmpty()
  bookingId: string;
  @Field({ defaultValue: 'credit_card', description: 'วิธีการชำระเงิน: credit_card | promptpay' })
  @IsIn(['credit_card', 'promptpay'])
  paymentMethod: string = 'credit_card';

  @Field()
  @IsString()
  @IsNotEmpty()
  omiseToken: string;
}
