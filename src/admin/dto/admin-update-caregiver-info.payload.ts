import { ObjectType, Field, ID } from '@nestjs/graphql';

@ObjectType()
export class AdminUpdateCaregiverInfoPayload {
  @Field(() => ID, { description: 'Caregiver UUID' })
  id: string;

  @Field({ description: 'First name (extracted from fullName)' })
  firstName: string;

  @Field({ description: 'Last name (extracted from fullName)' })
  lastName: string;

  @Field({ description: 'Thai national ID (13 digits)' })
  idCardNumber: string;

  @Field({ description: 'Email address of the linked user' })
  email: string;
}
