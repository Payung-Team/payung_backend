import { ObjectType, Field, ID } from '@nestjs/graphql';

@ObjectType()
export class User {
  @Field(() => ID)
  id!: string;

  @Field()
  email!: string;

  @Field()
  displayName!: string;

  @Field()
  role!: string;

  @Field()
  isActive!: boolean;

  @Field()
  createdAt!: Date;
}
