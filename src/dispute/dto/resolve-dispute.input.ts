import { Field, Float, ID, InputType } from '@nestjs/graphql';
import { IsEnum, IsNumber, IsOptional, IsPositive, IsString, IsUUID, MinLength } from 'class-validator';
import { DisputeDecision } from '../entities/dispute-decision.enum';

@InputType()
export class ResolveDisputeInput {
  @Field(() => ID)
  @IsUUID()
  bookingId: string;

  @Field(() => DisputeDecision)
  @IsEnum(DisputeDecision)
  decision: DisputeDecision;

  /** required when decision = refund_partial */
  @Field(() => Float, { nullable: true })
  @IsOptional()
  @IsNumber()
  @IsPositive()
  refundAmount?: number;

  @Field()
  @IsString()
  @MinLength(1)
  notes: string;
}
