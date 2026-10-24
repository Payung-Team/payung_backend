import { Field, InputType } from '@nestjs/graphql';
import { ValidAppEmail } from '../../../common/validators/valid-app-email.validator';

@InputType()
export class RequestPasswordResetInput {
  @Field({ description: 'Email address to send the password reset link to' })
  @ValidAppEmail()
  email!: string;
}
