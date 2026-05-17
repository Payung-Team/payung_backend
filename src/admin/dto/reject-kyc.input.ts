import { InputType, Field, ID } from '@nestjs/graphql';
import { IsUUID, ArrayNotEmpty, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';
import { RejectionReasonItem } from './rejection-reason.input';

@InputType()
export class RejectKycInput {
  @Field(() => ID, { description: 'UUID of the caregiver to reject' })
  @IsUUID('4', { message: 'caregiverId ต้องเป็น UUID ที่ถูกต้อง' })
  caregiverId!: string;

  @Field(() => [RejectionReasonItem], { description: 'One or more rejection reasons' })
  @ArrayNotEmpty({ message: 'ต้องระบุเหตุผลอย่างน้อย 1 ข้อ' })
  @ValidateNested({ each: true })
  @Type(() => RejectionReasonItem)
  reasons!: RejectionReasonItem[];
}
