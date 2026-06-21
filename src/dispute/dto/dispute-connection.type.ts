import { Field, Int, ObjectType } from '@nestjs/graphql';
import { DisputeBooking } from '../entities/dispute-booking.entity';

@ObjectType()
export class DisputeConnection {
  @Field(() => [DisputeBooking]) nodes: DisputeBooking[];
  @Field(() => Int) totalCount: number;
  @Field(() => Int) page: number;
  @Field(() => Int) limit: number;
  @Field() hasNextPage: boolean;
}
