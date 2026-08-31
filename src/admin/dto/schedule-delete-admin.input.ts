import { InputType, Field, Int } from '@nestjs/graphql';
import { IsIn, IsString, IsNotEmpty, IsOptional } from 'class-validator';

const ALLOWED_GRACE_PERIODS = [7, 14, 30, 60] as const;

@InputType()
export class ScheduleDeleteAdminInput {
  @Field({ description: 'ID of the target admin user' })
  @IsString()
  @IsNotEmpty()
  adminId: string;

  @Field(() => Int, {
    defaultValue: 30,
    description: 'Grace period in days before permanent deletion. Allowed: 7, 14, 30, 60',
  })
  @IsOptional()
  @IsIn(ALLOWED_GRACE_PERIODS, { message: 'Grace period must be 7, 14, 30, or 60 days' })
  gracePeriodDays?: number;
}
