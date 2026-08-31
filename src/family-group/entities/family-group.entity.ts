/**
 * FamilyGroup GraphQL entity — output type for family group data
 *
 * Minimal shape: only what acceptInvite needs to return.
 * Expand when create-group / group-detail tickets land.
 */
import { ObjectType, Field, ID } from '@nestjs/graphql';

@ObjectType()
export class FamilyGroupType {
  @Field(() => ID, { description: 'UUID of the family group' })
  id!: string;

  @Field({ description: 'Display name of the family group' })
  name!: string;

  @Field({ description: 'When the group was created' })
  createdAt!: Date;
}
