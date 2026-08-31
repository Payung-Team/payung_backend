import { Field, ObjectType } from '@nestjs/graphql';

@ObjectType()
export class RequestPasswordResetResponse {
  @Field({ description: 'Always true — does not reveal whether the email exists' })
  success!: boolean;

  @Field({ nullable: true })
  message?: string;
}
