import { ObjectType, Field, Int } from '@nestjs/graphql';
import { Payment } from './payment.type';

@ObjectType()
export class PaymentConnection {
  @Field(() => [Payment])
  nodes: Payment[];

  @Field(() => Int)
  totalCount: number;

  @Field(() => Int)
  page: number;

  @Field(() => Int)
  limit: number;

  @Field()
  hasNextPage: boolean;
}
