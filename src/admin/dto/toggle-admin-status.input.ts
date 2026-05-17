import { InputType, Field } from '@nestjs/graphql';
import { IsBoolean, IsString, IsNotEmpty } from 'class-validator';

@InputType()
export class ToggleAdminStatusInput {
  @Field({ description: 'ID of the target admin user' })
  @IsString()
  @IsNotEmpty()
  adminId: string;

  @Field({ description: 'true = activate, false = deactivate' })
  @IsBoolean()
  isActive: boolean;
}
