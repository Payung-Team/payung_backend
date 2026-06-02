import { Field, InputType } from '@nestjs/graphql';
import { MinLength } from 'class-validator';

@InputType()
export class UpdatePasswordInput {
  @Field({ description: 'New password (minimum 8 characters)' })
  @MinLength(8, { message: 'รหัสผ่านต้องมีอย่างน้อย 8 ตัวอักษร' })
  newPassword!: string;
}
