import { ObjectType, Field } from '@nestjs/graphql';

@ObjectType()
export class HealthStatus {
  @Field()
  status: string;

  @Field()
  timestamp: string;

  @Field()
  supabaseConnected: boolean;
}
