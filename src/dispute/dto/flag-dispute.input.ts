import { Field, ID, InputType } from '@nestjs/graphql';
import { IsString, IsUUID, MinLength } from 'class-validator';

@InputType()
export class FlagDisputeInput {
  @Field(() => ID)
  @IsUUID()
  bookingId: string;

  @Field()
  @IsString()
  @MinLength(20, { message: 'reason ต้องมีความยาวอย่างน้อย 20 ตัวอักษร' })
  reason: string;
}
