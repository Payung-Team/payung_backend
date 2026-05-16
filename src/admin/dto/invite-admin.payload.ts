import { ObjectType, Field } from '@nestjs/graphql';
import { User } from '../../identity/auth/entities/user.entity';

@ObjectType()
export class InviteAdminPayload {
  @Field(() => User)
  user: User;

  @Field({ description: 'Whether the invitation email with temp password was sent' })
  tempPasswordSent: boolean;
}
