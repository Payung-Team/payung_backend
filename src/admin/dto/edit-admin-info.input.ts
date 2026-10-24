import { InputType, Field, ID, Int } from '@nestjs/graphql';
import { IsInt, IsOptional, IsString, IsUUID, MinLength } from 'class-validator';
import { ValidAppEmail } from '../../common/validators/valid-app-email.validator';

@InputType()
export class EditAdminInfoInput {
  @Field(() => ID, { description: 'UUID of the admin to edit' })
  @IsUUID('4')
  adminId: string;

  @Field({ nullable: true, description: 'First name (optional)' })
  @IsOptional()
  @IsString()
  @MinLength(1)
  firstName?: string;

  @Field({ nullable: true, description: 'Last name (optional)' })
  @IsOptional()
  @IsString()
  @MinLength(1)
  lastName?: string;

  @Field({ nullable: true, description: 'New email address (optional)' })
  @IsOptional()
  @ValidAppEmail()
  email?: string;

  @Field(() => Int, { nullable: true, description: '3 = ADMIN, 4 = SUPER_ADMIN (optional)' })
  @IsOptional()
  @IsInt()
  role?: number;
}
