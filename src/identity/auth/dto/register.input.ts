/* eslint-disable @typescript-eslint/no-unsafe-call */
import { InputType, Field } from '@nestjs/graphql';
import { IsEmail, IsIn, MinLength } from 'class-validator';

@InputType()
export class RegisterInput {
  @Field()
  @IsEmail({}, { message: 'Invalid email format' })
  email!: string;

  @Field()
  @MinLength(6, { message: 'Password must be at least 6 characters' })
  password!: string;

  @Field()
  @IsIn(['patient', 'caregiver'], {
    message: 'Role must be patient or caregiver',
  })
  role!: string;
}
