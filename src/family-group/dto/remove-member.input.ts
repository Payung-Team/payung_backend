import { Field, ID, InputType } from '@nestjs/graphql';
import { IsString, IsUUID } from 'class-validator';

@InputType()
export class RemoveMemberInput {
  @Field(() => ID, {
    description: 'กลุ่มที่จะนำสมาชิกออก — ต้องเป็นเจ้าของกลุ่ม',
  })
  @IsUUID()
  groupId: string;

  @Field(() => ID, {
    description:
      'users.id ของสมาชิกที่จะนำออก (ไม่ใช่ family_group_members.id) — นำตัวเองออกไม่ได้ จะได้ LAST_OWNER',
  })
  // users.id เป็น TEXT ในดีบี (ไม่ใช่ UUID column) จึงใช้ IsString ไม่ใช่ IsUUID
  @IsString()
  userId: string;
}
