import { ObjectType, Field } from '@nestjs/graphql';
import { User } from '../../identity/auth/entities/user.entity';

@ObjectType()
export class EditAdminInfoPayload {
  @Field(() => User)
  user: User;
}
