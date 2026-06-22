import { Field, InputType } from '@nestjs/graphql';
import { IsNotEmpty, IsString } from 'class-validator';

@InputType()
export class CreatePaymentInput {
  @Field()
  @IsString()
  @IsNotEmpty()
  bookingId: string;

  @Field()
  @IsString()
  @IsNotEmpty()
  omiseToken: string;
}
