import { ObjectType, Field } from '@nestjs/graphql';

@ObjectType()
export class FieldLockResult {
  @Field({ description: 'Whether the operation succeeded' })
  success: boolean;

  @Field({ description: 'The field that was locked or unlocked' })
  fieldName: string;

  @Field({ description: 'Lock state after the operation' })
  locked: boolean;

  @Field({ nullable: true, description: 'Display name of the admin who locked the field' })
  lockedBy?: string;

  @Field({ nullable: true, description: 'When the field was locked' })
  lockedAt?: Date;
}

@ObjectType()
export class LockedField {
  @Field({ description: 'The locked field name (camelCase)' })
  fieldName: string;

  @Field({ description: 'Display name of the admin who locked this field' })
  lockedBy: string;

  @Field({ description: 'When the lock was applied' })
  lockedAt: Date;
}
