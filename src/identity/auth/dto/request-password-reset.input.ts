import { Field, InputType } from '@nestjs/graphql';
import { IsEmail } from 'class-validator';

@InputType()
export class RequestPasswordResetInput {
  @Field({ description: 'Email address to send the password reset link to' })
  @IsEmail({}, { message: 'Invalid email format' })
  email!: string;
}
