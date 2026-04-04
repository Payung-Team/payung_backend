import { InputType, Field } from '@nestjs/graphql';

@InputType()
export class RegisterInput {
  @Field({ description: 'Email address' })
  email: string;

  @Field({ description: 'Password (min 6 characters)' })
  password: string;

  @Field({ description: 'User role: patient or caregiver' })
  role: string;
}
