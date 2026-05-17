import { ObjectType, Field, Int } from '@nestjs/graphql';
import { User } from '../../identity/auth/entities/user.entity';

@ObjectType()
export class ScheduleDeleteAdminPayload {
  @Field(() => User)
  user: User;

  @Field({ description: 'Datetime when the account will be permanently deleted' })
  scheduledDeleteAt: Date;

  @Field(() => Int, { description: 'Grace period in days that was set' })
  gracePeriodDays: number;
}
