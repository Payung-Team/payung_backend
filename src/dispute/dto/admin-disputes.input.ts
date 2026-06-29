import { Field, InputType, Int } from '@nestjs/graphql';
import { IsEnum, IsInt, IsOptional, Max, Min } from 'class-validator';
import { DisputeStatus } from '../entities/dispute-status.enum';

@InputType()
export class AdminDisputesInput {
  @Field(() => DisputeStatus, { nullable: true })
  @IsOptional()
  @IsEnum(DisputeStatus)
  disputeStatus?: DisputeStatus;

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
