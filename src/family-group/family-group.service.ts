/**
 * FamilyGroupService — Business logic for family group operations (PYG-392)
 *
 * acceptInvite(token, user):
 *   1. Hash token → sha256
 *   2. Look up invite by hash
 *   3. Check if user is already an active member → ALREADY_MEMBER (friendliest exit)
 *   4. Reject non-PENDING invites → INVITE_INVALID
 *   5. Reject expired invites → INVITE_EXPIRED
 *   6. In one $transaction:
 *      a. Conditional updateMany on invite (status='PENDING') → race-safe
 *      b. Upsert member on [groupId, userId] composite key → rejoin-safe
 *      c. Insert MEMBER_JOINED activity with email mismatch metadata
 *   7. Log when invited email ≠ logged-in user email
 *
 * Error codes:
 *   INVITE_INVALID — token hash not found, invite revoked, or consumed by someone else
 *   INVITE_EXPIRED — invite past its expiresAt
 */
import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import * as crypto from 'crypto';
import { PrismaService } from '../common/prisma.service';
import { ClockService } from '../common/clock.service';
import { AuthUser } from '../common/decorators/current-user.decorator';
import { AcceptInvitePayload, AcceptInviteStatus } from './dto/accept-invite.payload';

@Injectable()
export class FamilyGroupService {
  private readonly logger = new Logger(FamilyGroupService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly clock: ClockService,
  ) {}

  /**
   * Accept a family group invitation.
   *
   * @param token   Raw invite token from the invitation link
   * @param user    Authenticated user accepting the invite
   * @returns       AcceptInvitePayload with group info and JOINED/ALREADY_MEMBER status
   * @throws        NotFoundException  — INVITE_INVALID (hash mismatch, revoked, consumed by other)
   * @throws        BadRequestException — INVITE_EXPIRED
   */
  async acceptInvite(token: string, user: AuthUser): Promise<AcceptInvitePayload> {
    // ── 1. Hash the raw token ────────────────────────────────────────────────
    const tokenHash = crypto.createHash('sha256').update(token).digest('hex');

    // ── 2. Look up invite by hash ────────────────────────────────────────────
    const invite = await this.prisma.familyGroupInvite.findUnique({
      where: { tokenHash },
      include: { group: true },
    });

    if (!invite) {
      throw new NotFoundException('INVITE_INVALID');
    }

    // ── 3. Already a member? Return early (friendliest exit first) ───────────
    // This covers: same invite clicked twice, or joined via a different invite.
    // Checking before status also gives a friendly result when the user clicks
    // the link after the invite expired — they're already in, so it's fine.
    const existingMember = await this.prisma.familyGroupMember.findUnique({
      where: {
        groupId_userId: { groupId: invite.groupId, userId: user.id },
      },
    });

    if (existingMember?.status === 'ACTIVE') {
      return {
        status: AcceptInviteStatus.ALREADY_MEMBER,
        group: invite.group,
      };
    }

    // ── 4. Non-PENDING invite → INVITE_INVALID ───────────────────────────────
    // ACCEPTED (consumed by someone else) or REVOKED
    if (invite.status !== 'PENDING') {
      throw new NotFoundException('INVITE_INVALID');
    }

    // ── 5. Expired → INVITE_EXPIRED ──────────────────────────────────────────
    const now = this.clock.now();
    if (invite.expiresAt < now) {
      throw new BadRequestException('INVITE_EXPIRED');
    }

    // ── 6. Transaction: conditional update + upsert member + activity ─────────
    const emailsMatch =
      invite.invitedEmail.trim().toLowerCase() === user.email.trim().toLowerCase();

    await this.prisma.$transaction(async (tx) => {
      // 6a. Conditional update: only succeeds if still PENDING (race-safe)
      const { count } = await tx.familyGroupInvite.updateMany({
        where: { id: invite.id, status: 'PENDING' },
        data: {
          status: 'ACCEPTED',
          acceptedAt: now,
          acceptedBy: user.id,
        },
      });

      if (count === 0) {
        // Lost the race — another request consumed this invite between our read and write.
        // Throwing inside $transaction rolls back any partial writes.
        throw new NotFoundException('INVITE_INVALID');
      }

      // 6b. Upsert member on [groupId, userId] composite key
      //     Handles the case where the user previously left (status=REMOVED)
      //     and is rejoining — sets status back to ACTIVE.
      await tx.familyGroupMember.upsert({
        where: {
          groupId_userId: { groupId: invite.groupId, userId: user.id },
        },
        create: {
          groupId: invite.groupId,
          userId: user.id,
          role: 'MEMBER',
          status: 'ACTIVE',
          joinedAt: now,
        },
        update: {
          status: 'ACTIVE',
          role: 'MEMBER',
          joinedAt: now,
        },
      });

      // 6c. Activity log
      await tx.familyGroupActivity.create({
        data: {
          groupId: invite.groupId,
          actorId: user.id,
          action: 'MEMBER_JOINED',
          metadata: {
            invitedEmail: invite.invitedEmail,
            acceptedByEmail: user.email,
            emailMatch: emailsMatch,
          },
        },
      });
    });

    // ── 7. Log email mismatch (outside transaction — non-critical) ───────────
    if (!emailsMatch) {
      this.logger.warn(
        `Invite accepted by different email: invited=${invite.invitedEmail}, ` +
        `accepted=${user.email}, userId=${user.id}, inviteId=${invite.id}`,
      );
    }

    return {
      status: AcceptInviteStatus.JOINED,
      group: invite.group,
    };
  }
}
