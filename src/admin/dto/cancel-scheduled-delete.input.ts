import { InputType, Field } from '@nestjs/graphql';
import { IsString, IsNotEmpty } from 'class-validator';

@InputType()
export class CancelScheduledDeleteInput {
  @Field({ description: 'ID of the target admin user whose scheduled deletion to cancel' })
  @IsString()
  @IsNotEmpty()
  adminId: string;
}
