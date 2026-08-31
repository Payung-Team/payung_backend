/**
 * FamilyGroupResolver — GraphQL mutations for family group (PYG-392)
 *
 * Mutations:
 *   acceptInvite(token: String!): AcceptInvitePayload
 *     → Accept a family group invite using the raw token from the invitation link.
 *     → Returns JOINED or ALREADY_MEMBER with the group info.
 *
 * Guards:
 *   SupabaseAuthGuard — any authenticated user can accept (no role restriction).
 *   Invited email may differ from logged-in user's email — allowed by design.
 *
 * @example
 * mutation {
 *   acceptInvite(token: "abc123...") {
 *     status
 *     group { id name createdAt }
 *   }
 * }
 */
import { Resolver, Mutation, Args } from '@nestjs/graphql';
import { UseGuards } from '@nestjs/common';
import { FamilyGroupService } from './family-group.service';
import { AcceptInvitePayload } from './dto/accept-invite.payload';
import { SupabaseAuthGuard } from '../common/guards/supabase-auth.guard';
import { CurrentUser, AuthUser } from '../common/decorators/current-user.decorator';

@Resolver()
@UseGuards(SupabaseAuthGuard)
export class FamilyGroupResolver {
  constructor(private readonly familyGroupService: FamilyGroupService) {}

  @Mutation(() => AcceptInvitePayload, {
    description:
      'Accept a family group invitation. Any authenticated user can accept. ' +
      'Returns JOINED on success, ALREADY_MEMBER if already in the group. ' +
      'Throws INVITE_INVALID or INVITE_EXPIRED on failure.',
  })
  async acceptInvite(
    @Args('token', { description: 'Raw invite token from the invitation link' })
    token: string,
    @CurrentUser() user: AuthUser,
  ): Promise<AcceptInvitePayload> {
    return this.familyGroupService.acceptInvite(token, user);
  }
}
