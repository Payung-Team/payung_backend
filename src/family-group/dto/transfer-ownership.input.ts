import { Field, ID, InputType } from '@nestjs/graphql';
import { IsString, IsUUID } from 'class-validator';

@InputType()
export class TransferOwnershipInput {
  @Field(() => ID, {
    description: 'กลุ่มที่จะโอนสิทธิ์ — ต้องเป็นเจ้าของกลุ่มปัจจุบัน',
  })
  @IsUUID()
  groupId: string;

  @Field(() => ID, {
    description:
      'users.id ของเจ้าของคนใหม่ — ต้องเป็นสมาชิก ACTIVE ของกลุ่มนี้อยู่แล้ว (เชิญคนนอกมาเป็นเจ้าของตรง ๆ ไม่ได้)',
  })
  @IsString()
  newOwnerUserId: string;
}
