import { Field, ObjectType } from '@nestjs/graphql';

@ObjectType()
export class UpdatePasswordResponse {
  @Field({ description: 'Whether the password was updated successfully' })
  success!: boolean;

  @Field({ nullable: true })
  message?: string;
}
