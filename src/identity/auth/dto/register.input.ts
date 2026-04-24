/* eslint-disable @typescript-eslint/no-unsafe-call */
import { InputType, Field, Int } from '@nestjs/graphql';
import { IsEmail, IsIn, MinLength } from 'class-validator';

@InputType()
export class RegisterInput {
  @Field()
  @IsEmail({}, { message: 'Invalid email format' })
  email!: string;

  @Field()
  @MinLength(8, { message: 'Password must be at least 8 characters' })
  password!: string;

  @Field(() => Int)
  @IsIn([1, 2], {
    message: 'Role must be 1 (patient) or 2 (caregiver)',
  })
  role!: number;
}
