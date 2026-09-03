/**
 * FamilyGroupService — Unit tests for acceptInvite (PYG-392)
 *
 * 9 cases:
 *   1. Valid PENDING invite → JOINED (transaction: conditional update + upsert + activity)
 *   2. Token hash not found → INVITE_INVALID
 *   3. Revoked invite → INVITE_INVALID
 *   4. Expired invite → INVITE_EXPIRED
 *   5. Already-consumed invite (ACCEPTED) → INVITE_INVALID
 *   6. User already active member → ALREADY_MEMBER (idempotent, before status check)
 *   7. Email mismatch — invited ≠ logged-in → still JOINED, logs warning
 *   8. Rejoin after leave — upsert updates existing REMOVED row to ACTIVE
 *   9. Race-loss — conditional updateMany returns count=0 → INVITE_INVALID (rolls back)
 */
import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import * as crypto from 'crypto';
import { FamilyGroupService } from './family-group.service';
import { PrismaService } from '../common/prisma.service';
import { ClockService } from '../common/clock.service';
import { AcceptInviteStatus } from './dto/accept-invite.payload';

// ─── Test fixtures ───────────────────────────────────────────────────────────

const RAW_TOKEN = 'a'.repeat(64); // 64 hex chars (simulates crypto.randomBytes(32).toString('hex'))
const TOKEN_HASH = crypto.createHash('sha256').update(RAW_TOKEN).digest('hex');

const NOW = new Date('2026-09-01T00:00:00Z');
const ONE_DAY_LATER = new Date('2026-09-02T00:00:00Z');
const ONE_DAY_AGO = new Date('2026-08-31T00:00:00Z');

const currentUser = {
  id: 'user-accept-id',
  supabaseUid: 'sup-uid-1',
  email: 'acceptor@example.com',
  role: 1,
  isSuspended: false,
};

const fakeGroup = {
  id: 'group-uuid-1',
  name: 'The Smiths',
  createdBy: 'owner-id',
  createdAt: ONE_DAY_AGO,
  updatedAt: ONE_DAY_AGO,
};

function fakeInvite(overrides: Record<string, unknown> = {}) {
  return {
    id: 'invite-uuid-1',
    groupId: fakeGroup.id,
    invitedEmail: 'acceptor@example.com',
    invitedBy: 'owner-id',
    tokenHash: TOKEN_HASH,
    status: 'PENDING',
    expiresAt: ONE_DAY_LATER,
    acceptedAt: null,
    acceptedBy: null,
    createdAt: ONE_DAY_AGO,
    group: fakeGroup,
    ...overrides,
  };
}

// ─── Prisma mock shape ───────────────────────────────────────────────────────

type TxMock = {
  familyGroupInvite: { updateMany: jest.Mock };
  familyGroupMember: { upsert: jest.Mock };
  familyGroupActivity: { create: jest.Mock };
};

function buildPrismaMock() {
  const tx: TxMock = {
    familyGroupInvite: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
    familyGroupMember: { upsert: jest.fn().mockResolvedValue({}) },
    familyGroupActivity: { create: jest.fn().mockResolvedValue({}) },
  };

  return {
    familyGroupInvite: {
      findUnique: jest.fn(),
    },
    familyGroupMember: {
      findUnique: jest.fn(),
    },
    $transaction: jest.fn(async (cb: (t: TxMock) => Promise<unknown>) => cb(tx)),
    // expose tx for assertion in individual tests
    _tx: tx,
  };
}

// ─── Test suite ──────────────────────────────────────────────────────────────

describe('FamilyGroupService — acceptInvite', () => {
  let service: FamilyGroupService;
  let prisma: ReturnType<typeof buildPrismaMock>;

  beforeEach(async () => {
    prisma = buildPrismaMock();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        FamilyGroupService,
        { provide: PrismaService, useValue: prisma },
        { provide: ClockService, useValue: { now: () => NOW } },
      ],
    }).compile();

    service = module.get<FamilyGroupService>(FamilyGroupService);
  });

  // ─── Case 1: Valid PENDING invite → JOINED ──────────────────────────────

  it('accepts a valid PENDING invite and returns JOINED', async () => {
    prisma.familyGroupInvite.findUnique.mockResolvedValue(fakeInvite());
    prisma.familyGroupMember.findUnique.mockResolvedValue(null);

    const result = await service.acceptInvite(RAW_TOKEN, currentUser);

    expect(result.status).toBe(AcceptInviteStatus.JOINED);
    expect(result.group.id).toBe(fakeGroup.id);
    expect(result.group.name).toBe(fakeGroup.name);

    // Verify findUnique was called with the correct hash
    expect(prisma.familyGroupInvite.findUnique).toHaveBeenCalledWith({
      where: { tokenHash: TOKEN_HASH },
      include: { group: true },
    });

    // Verify transaction was called
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);

    // Verify conditional update inside tx
    expect(prisma._tx.familyGroupInvite.updateMany).toHaveBeenCalledWith({
      where: { id: 'invite-uuid-1', status: 'PENDING' },
      data: expect.objectContaining({
        status: 'ACCEPTED',
        acceptedBy: currentUser.id,
      }),
    });

    // Verify upsert member
    expect(prisma._tx.familyGroupMember.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { groupId_userId: { groupId: fakeGroup.id, userId: currentUser.id } },
        create: expect.objectContaining({
          role: 'MEMBER',
          status: 'ACTIVE',
        }),
        update: expect.objectContaining({
          status: 'ACTIVE',
        }),
      }),
    );

    // Verify activity log
    expect(prisma._tx.familyGroupActivity.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        groupId: fakeGroup.id,
        actorId: currentUser.id,
        action: 'MEMBER_JOINED',
        metadata: expect.objectContaining({ emailMatch: true }),
      }),
    });
  });

  // ─── Case 2: Token hash not found → INVITE_INVALID ─────────────────────

  it('throws INVITE_INVALID when token hash is not found', async () => {
    prisma.familyGroupInvite.findUnique.mockResolvedValue(null);

    await expect(service.acceptInvite(RAW_TOKEN, currentUser)).rejects.toThrow(
      NotFoundException,
    );
    await expect(service.acceptInvite(RAW_TOKEN, currentUser)).rejects.toThrow(
      'INVITE_INVALID',
    );

    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  // ─── Case 3: Revoked invite → INVITE_INVALID ───────────────────────────

  it('throws INVITE_INVALID for a REVOKED invite', async () => {
    prisma.familyGroupInvite.findUnique.mockResolvedValue(
      fakeInvite({ status: 'REVOKED' }),
    );
    prisma.familyGroupMember.findUnique.mockResolvedValue(null);

    await expect(service.acceptInvite(RAW_TOKEN, currentUser)).rejects.toThrow(
      'INVITE_INVALID',
    );

    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  // ─── Case 4: Expired invite → INVITE_EXPIRED ───────────────────────────

  it('throws INVITE_EXPIRED when invite is past expiresAt', async () => {
    prisma.familyGroupInvite.findUnique.mockResolvedValue(
      fakeInvite({ expiresAt: ONE_DAY_AGO }), // expired yesterday
    );
    prisma.familyGroupMember.findUnique.mockResolvedValue(null);

    await expect(service.acceptInvite(RAW_TOKEN, currentUser)).rejects.toThrow(
      BadRequestException,
    );
    await expect(service.acceptInvite(RAW_TOKEN, currentUser)).rejects.toThrow(
      'INVITE_EXPIRED',
    );

    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  // ─── Case 5: Already-consumed invite (ACCEPTED by someone else) ────────

  it('throws INVITE_INVALID for an ACCEPTED invite when user is not a member', async () => {
    prisma.familyGroupInvite.findUnique.mockResolvedValue(
      fakeInvite({ status: 'ACCEPTED', acceptedBy: 'someone-else' }),
    );
    prisma.familyGroupMember.findUnique.mockResolvedValue(null);

    await expect(service.acceptInvite(RAW_TOKEN, currentUser)).rejects.toThrow(
      'INVITE_INVALID',
    );

    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  // ─── Case 6: Already active member → ALREADY_MEMBER (idempotent) ───────

  it('returns ALREADY_MEMBER when user is already an active group member', async () => {
    prisma.familyGroupInvite.findUnique.mockResolvedValue(fakeInvite());
    prisma.familyGroupMember.findUnique.mockResolvedValue({
      id: 'member-uuid-1',
      groupId: fakeGroup.id,
      userId: currentUser.id,
      role: 'MEMBER',
      status: 'ACTIVE',
      joinedAt: ONE_DAY_AGO,
    });

    const result = await service.acceptInvite(RAW_TOKEN, currentUser);

    expect(result.status).toBe(AcceptInviteStatus.ALREADY_MEMBER);
    expect(result.group.id).toBe(fakeGroup.id);
    // No transaction should be called — early return
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  // Also: already active member + expired invite → still ALREADY_MEMBER
  // (membership check runs before status/expiry check for friendlier UX)
  it('returns ALREADY_MEMBER even when the invite is expired', async () => {
    prisma.familyGroupInvite.findUnique.mockResolvedValue(
      fakeInvite({ status: 'ACCEPTED', expiresAt: ONE_DAY_AGO }),
    );
    prisma.familyGroupMember.findUnique.mockResolvedValue({
      id: 'member-uuid-1',
      groupId: fakeGroup.id,
      userId: currentUser.id,
      role: 'MEMBER',
      status: 'ACTIVE',
      joinedAt: ONE_DAY_AGO,
    });

    const result = await service.acceptInvite(RAW_TOKEN, currentUser);

    expect(result.status).toBe(AcceptInviteStatus.ALREADY_MEMBER);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  // ─── Case 7: Email mismatch → still JOINED, logs warning ───────────────

  it('allows acceptance when invited email differs from user email', async () => {
    const inviteForOtherEmail = fakeInvite({
      invitedEmail: 'ORIGINAL@example.com', // different email, different case
    });
    prisma.familyGroupInvite.findUnique.mockResolvedValue(inviteForOtherEmail);
    prisma.familyGroupMember.findUnique.mockResolvedValue(null);

    const logSpy = jest.spyOn(
      (service as any).logger,
      'warn',
    );

    const result = await service.acceptInvite(RAW_TOKEN, currentUser);

    expect(result.status).toBe(AcceptInviteStatus.JOINED);

    // Verify activity metadata records both emails
    expect(prisma._tx.familyGroupActivity.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        metadata: expect.objectContaining({
          invitedEmail: 'ORIGINAL@example.com',
          acceptedByEmail: currentUser.email,
          emailMatch: false,
        }),
      }),
    });

    // Verify warning was logged
    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining('different email'),
    );

    logSpy.mockRestore();
  });

  // ─── Case 8: Rejoin after leave (REMOVED member) → JOINED via upsert ──

  it('reactivates a REMOVED member via upsert', async () => {
    prisma.familyGroupInvite.findUnique.mockResolvedValue(fakeInvite());
    // Member exists but with REMOVED status — not ACTIVE, so no early return
    prisma.familyGroupMember.findUnique.mockResolvedValue({
      id: 'member-uuid-1',
      groupId: fakeGroup.id,
      userId: currentUser.id,
      role: 'MEMBER',
      status: 'REMOVED',
      joinedAt: ONE_DAY_AGO,
    });

    const result = await service.acceptInvite(RAW_TOKEN, currentUser);

    expect(result.status).toBe(AcceptInviteStatus.JOINED);
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);

    // Upsert should update existing row to ACTIVE
    expect(prisma._tx.familyGroupMember.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        update: expect.objectContaining({ status: 'ACTIVE' }),
      }),
    );
  });

  // ─── Case 9: Race-loss — conditional update returns count=0 ─────────────

  it('rolls back and throws INVITE_INVALID when race-loss occurs (count=0)', async () => {
    prisma.familyGroupInvite.findUnique.mockResolvedValue(fakeInvite());
    prisma.familyGroupMember.findUnique.mockResolvedValue(null);

    // Simulate race: updateMany returns count=0 (another request consumed the invite)
    prisma._tx.familyGroupInvite.updateMany.mockResolvedValue({ count: 0 });

    await expect(service.acceptInvite(RAW_TOKEN, currentUser)).rejects.toThrow(
      NotFoundException,
    );
    await expect(service.acceptInvite(RAW_TOKEN, currentUser)).rejects.toThrow(
      'INVITE_INVALID',
    );

    // Transaction was attempted (the throw inside rolls it back)
    expect(prisma.$transaction).toHaveBeenCalled();
  });
});
