import { ObjectType, Field, ID, Float } from '@nestjs/graphql';

@ObjectType()
export class Caregiver {
  @Field(() => ID)
  id!: string;

  @Field()
  userId!: string;

  @Field()
  kycStatus!: string;

  @Field(() => [String])
  skills!: string[];

  @Field(() => Float)
  hourlyRate!: number;

  @Field()
  isSearchable!: boolean;
}
