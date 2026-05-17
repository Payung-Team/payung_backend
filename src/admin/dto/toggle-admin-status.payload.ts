import { ObjectType, Field } from '@nestjs/graphql';
import { User } from '../../identity/auth/entities/user.entity';

@ObjectType()
export class ToggleAdminStatusPayload {
  @Field(() => User)
  user: User;

  @Field({ description: '"ADMIN_ACTIVATED" or "ADMIN_DEACTIVATED"' })
  action: string;
}
