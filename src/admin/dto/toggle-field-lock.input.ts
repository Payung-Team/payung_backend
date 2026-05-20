import { InputType, Field, registerEnumType, ID } from '@nestjs/graphql';
import { IsBoolean, IsString, IsUUID, MinLength } from 'class-validator';

export enum EntityTypeEnum {
  CAREGIVER_PROFILE = 'CAREGIVER_PROFILE',
  USER = 'USER',
}

registerEnumType(EntityTypeEnum, {
  name: 'EntityTypeEnum',
  description: 'Entity types that support field locking',
});

@InputType()
export class ToggleFieldLockInput {
  @Field(() => EntityTypeEnum, { description: 'Entity type: CAREGIVER_PROFILE or USER' })
  entityType: EntityTypeEnum;

  @Field(() => ID, { description: 'UUID of the caregiver or user' })
  @IsUUID('4')
  entityId: string;

  @Field({ description: 'Field name to lock/unlock (camelCase, e.g. "phone", "hourlyRate")' })
  @IsString()
  @MinLength(1)
  fieldName: string;

  @Field({ description: 'true = lock, false = unlock' })
  @IsBoolean()
  lock: boolean;
}
