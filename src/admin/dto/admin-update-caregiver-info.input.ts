import { InputType, Field, ID } from '@nestjs/graphql';
import { IsEmail, IsOptional, IsString, IsUUID, Matches, MinLength } from 'class-validator';

@InputType()
export class AdminUpdateCaregiverInfoInput {
  @Field(() => ID, { description: 'UUID of the caregiver to edit' })
  @IsUUID('4')
  caregiverId: string;

  @Field({ nullable: true, description: 'First name' })
  @IsOptional()
  @IsString()
  @MinLength(1)
  firstName?: string;

  @Field({ nullable: true, description: 'Last name' })
  @IsOptional()
  @IsString()
  @MinLength(1)
  lastName?: string;

  @Field({ nullable: true, description: 'Thai national ID (exactly 13 digits)' })
  @IsOptional()
  @IsString()
  @Matches(/^\d{13}$/, { message: 'idCardNumber must be exactly 13 digits' })
  idCardNumber?: string;

  @Field({ nullable: true, description: 'Email address (must be unique)' })
  @IsOptional()
  @IsEmail()
  email?: string;
}
