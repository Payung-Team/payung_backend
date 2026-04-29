import { ObjectType, Field } from '@nestjs/graphql';

@ObjectType()
export class KycStatusPayload {
  @Field({ description: 'KYC status: none | pending | verified | rejected' })
  status!: string;

  @Field({ nullable: true, description: 'When KYC was submitted' })
  submittedAt?: Date;

  @Field({ nullable: true, description: 'When KYC was verified by admin' })
  verifiedAt?: Date;

  @Field({ nullable: true, description: 'Rejection reason from admin review' })
  rejectedReason?: string;
}
