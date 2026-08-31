/**
 * AcceptInvitePayload — return type for the acceptInvite mutation
 *
 * status:
 *   JOINED         — user was added to the group in this call
 *   ALREADY_MEMBER — user was already an active member (idempotent return)
 */
import { ObjectType, Field, registerEnumType } from '@nestjs/graphql';
import { FamilyGroupType } from '../entities/family-group.entity';

export enum AcceptInviteStatus {
  JOINED = 'JOINED',
  ALREADY_MEMBER = 'ALREADY_MEMBER',
}

registerEnumType(AcceptInviteStatus, {
  name: 'AcceptInviteStatus',
  description: 'Result of accepting a family group invite',
});

@ObjectType()
export class AcceptInvitePayload {
  @Field(() => AcceptInviteStatus, {
    description: 'JOINED = new member, ALREADY_MEMBER = idempotent no-op',
  })
  status!: AcceptInviteStatus;

  @Field(() => FamilyGroupType, { description: 'The family group that was joined' })
  group!: FamilyGroupType;
}
