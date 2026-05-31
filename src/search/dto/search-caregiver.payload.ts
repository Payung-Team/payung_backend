import { ObjectType, Field, ID, Int, Float } from '@nestjs/graphql';

@ObjectType()
export class CaregiverSummary {
  @Field(() => ID, { description: 'Caregiver UUID' })
  id: string;

  @Field({ description: 'Full name' })
  fullName: string;

  @Field({ nullable: true, description: 'Avatar URL from user profile' })
  avatarUrl?: string;

  @Field(() => Float, { description: 'Hourly rate in THB' })
  hourlyRate: number;

  @Field(() => Float, { nullable: true, description: 'Average rating (null if no reviews yet)' })
  avgRating?: number;

  @Field(() => Int, { description: 'Total number of patient reviews' })
  reviewCount: number;

  @Field(() => [String], { description: 'Skill tags' })
  skills: string[];

  @Field({ nullable: true, description: 'Service area province' })
  province?: string;

  @Field({ nullable: true, description: 'Service area district' })
  district?: string;
}

@ObjectType()
export class SearchPagination {
  @Field(() => Int)
  page: number;

  @Field(() => Int)
  limit: number;

  @Field(() => Int)
  total: number;

  @Field(() => Int)
  totalPages: number;
}

@ObjectType()
export class SearchCaregiverPayload {
  @Field(() => [CaregiverSummary])
  data: CaregiverSummary[];

  @Field(() => SearchPagination)
  pagination: SearchPagination;
}
