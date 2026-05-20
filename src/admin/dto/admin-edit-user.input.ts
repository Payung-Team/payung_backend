import { InputType, Field, ID } from '@nestjs/graphql';
import { IsEmail, IsOptional, IsString, IsUUID, MaxLength, MinLength } from 'class-validator';

@InputType()
export class AdminEditUserInput {
  @Field(() => ID, { description: 'UUID of the user to edit' })
  @IsUUID('4')
  userId: string;

  @Field({ nullable: true, description: 'Display name' })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  displayName?: string;

  @Field({ nullable: true, description: 'Email address' })
  @IsOptional()
  @IsEmail()
  email?: string;

  @Field({ nullable: true, description: 'Phone number' })
  @IsOptional()
  @IsString()
  phone?: string;

  @Field({ nullable: true, description: 'Address' })
  @IsOptional()
  @IsString()
  address?: string;

  @Field({ nullable: true, description: 'Bio or personal description' })
  @IsOptional()
  @IsString()
  bio?: string;
}
