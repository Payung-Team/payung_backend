import { ObjectType, Field } from '@nestjs/graphql';
import { User } from '../../identity/auth/entities/user.entity';

@ObjectType()
export class CancelScheduledDeletePayload {
  @Field(() => User)
  user: User;

  @Field({ description: 'Whether the account was reactivated as part of the cancellation' })
  reactivated: boolean;
}
