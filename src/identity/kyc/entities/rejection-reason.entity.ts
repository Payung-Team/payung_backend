import { ObjectType, Field } from '@nestjs/graphql';

@ObjectType()
export class RejectionReason {
  @Field({ description: 'Short title of the rejection reason' })
  title: string;

  @Field({ nullable: true, description: 'Detailed explanation for the caregiver' })
  detail?: string;

  @Field({ nullable: true, description: 'Which document this reason refers to' })
  documentType?: string;
}
