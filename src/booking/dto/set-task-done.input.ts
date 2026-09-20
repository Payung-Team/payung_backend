import { Field, ID, InputType } from '@nestjs/graphql';
import { IsBoolean, IsUUID } from 'class-validator';

/**
 * SetTaskDoneInput — input สำหรับ mutation `setTaskDone` (PYG-361)
 * caregiver ติ๊ก/ยกเลิกติ๊กว่าทำรายการงานย่อยนี้แล้ว
 */
@InputType()
export class SetTaskDoneInput {
  @Field(() => ID)
  @IsUUID()
  taskId: string;

  @Field()
  @IsBoolean()
  done: boolean;
}
