import { InputType, Field, Int } from '@nestjs/graphql';
import { IsEnum, IsInt, IsOptional, Max, Min } from 'class-validator';
import { PaymentStatusEnum } from './payment.type';

@InputType()
export class AdminPaymentsInput {
  @Field(() => PaymentStatusEnum, { nullable: true })
  @IsOptional()
  @IsEnum(PaymentStatusEnum)
  status?: PaymentStatusEnum;

  @Field(() => Int, { nullable: true })
  @IsOptional()
  @IsInt()
  @Min(1)
  page?: number;

  @Field(() => Int, { nullable: true })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;
}
