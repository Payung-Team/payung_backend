import { Field, ID, InputType } from '@nestjs/graphql';
import { Transform } from 'class-transformer';
import { IsString, IsUUID, Length } from 'class-validator';
import {
  GROUP_NAME_MAX_LENGTH,
  GROUP_NAME_MIN_LENGTH,
} from '../family-group.constants';

const trim = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.trim() : value;

@InputType()
export class RenameFamilyGroupInput {
  @Field(() => ID, {
    description: 'กลุ่มที่จะเปลี่ยนชื่อ — ต้องเป็นเจ้าของกลุ่ม',
  })
  @IsUUID()
  groupId: string;

  @Field({ description: 'ชื่อใหม่ 1–80 ตัวอักษร' })
  @Transform(trim)
  @IsString()
  @Length(GROUP_NAME_MIN_LENGTH, GROUP_NAME_MAX_LENGTH, {
    message: `ชื่อกลุ่มต้องไม่เว้นว่าง และยาวไม่เกิน ${GROUP_NAME_MAX_LENGTH} ตัวอักษร`,
  })
  name: string;
}
