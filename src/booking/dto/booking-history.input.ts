import { Field, InputType, Int } from '@nestjs/graphql';
import { IsEnum, IsInt, IsOptional, Max, Min } from 'class-validator';
import { BookingStatusEnum } from './booking-summary.types';

@InputType()
export class BookingHistoryInput {
  @Field(() => BookingStatusEnum, { nullable: true })
  @IsOptional()
  @IsEnum(BookingStatusEnum)
  status?: BookingStatusEnum;

  @Field(() => Int, { nullable: true, defaultValue: 1 })
  @IsOptional()
  @IsInt()
  @Min(1)
  page?: number;

  @Field(() => Int, { nullable: true, defaultValue: 10 })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(50)
  limit?: number;
}
