import { InputType, Field, Int } from '@nestjs/graphql';
import { IsIn, IsString, MinLength } from 'class-validator';
import { ROLE_ID } from '../../common/constants/roles.constant';
import { ValidAppEmail } from '../../common/validators/valid-app-email.validator';

const INVITABLE_ROLES = [ROLE_ID.ADMIN, ROLE_ID.SUPER_ADMIN] as const;

@InputType()
export class InviteAdminInput {
  @Field({ description: 'Email address of the new admin' })
  @ValidAppEmail()
  email: string;

  @Field({ description: 'First name' })
  @IsString()
  @MinLength(1)
  firstName: string;

  @Field({ description: 'Last name' })
  @IsString()
  @MinLength(1)
  lastName: string;

  @Field(() => Int, { description: '3 = ADMIN, 4 = SUPER_ADMIN' })
  @IsIn(INVITABLE_ROLES, { message: 'role must be 3 (ADMIN) or 4 (SUPER_ADMIN)' })
  role: number;
}
