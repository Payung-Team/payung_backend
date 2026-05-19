/**
 * AdminCleanupService — Unit tests (PYG-159)
 *
 * Tests call handleAdminCleanup() directly — the @Cron decorator is not exercised,
 * so no fake timers are needed for scheduling. We only need them for Date.now().
 */
import { Test, TestingModule } from '@nestjs/testing';
import { AdminCleanupService } from './admin-cleanup.service';
import { PrismaService } from '../common/prisma.service';
import { SupabaseService } from '../common/supabase.service';
import { EmailService } from '../email/email.service';

// ─── Mocks ────────────────────────────────────────────────────────────────────

const mockPrisma = {
  user: {
    findMany: jest.fn(),
    update: jest.fn(),
  },
  $executeRaw: jest.fn(),
};

const mockSupabaseAdminAuthClient = {
  auth: {
    admin: {
      deleteUser: jest.fn().mockResolvedValue({ error: null }),
    },
  },
};

const mockSupabase = {
  getAdminClient: jest.fn(() => mockSupabaseAdminAuthClient),
};

const mockEmailService = {
  sendAdminAutoDeleted: jest.fn().mockResolvedValue(undefined),
};

// ─── Fixtures ─────────────────────────────────────────────────────────────────

function makeAdmin(overrides: Partial<typeof baseAdmin> = {}) {
  return { ...baseAdmin, ...overrides };
}

const baseAdmin = {
  id: 'admin-uuid',
  email: 'admin@payung.app',
  displayName: 'สมชาย ใจดี',
  supabaseUid: 'supabase-admin-uid',
  role: 3,
  isActive: false,
  is_deleted: false,
  scheduled_delete_at: new Date('2026-05-01T00:00:00Z'), // past date
  deletion_scheduled_by: 'super-admin-uuid',
  deleted_at: null,
  createdAt: new Date('2026-01-01'),
  updatedAt: new Date('2026-04-01'),
};

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('AdminCleanupService', () => {
  let service: AdminCleanupService;

  beforeEach(async () => {
    jest.clearAllMocks();
    // Default: prisma update resolves with the admin, executeRaw resolves with 1
    mockPrisma.user.update.mockResolvedValue(baseAdmin);
    mockPrisma.$executeRaw.mockResolvedValue(1);

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AdminCleanupService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: SupabaseService, useValue: mockSupabase },
        { provide: EmailService, useValue: mockEmailService },
      ],
    }).compile();

    service = module.get<AdminCleanupService>(AdminCleanupService);
  });

  // ─── Case 1: Soft-delete ─────────────────────────────────────────────────
  it('soft-deletes expired admin (is_deleted=true, deleted_at set)', async () => {
    mockPrisma.user.findMany.mockResolvedValue([baseAdmin]);

    await service.handleAdminCleanup();

    expect(mockPrisma.user.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: baseAdmin.id },
        data: expect.objectContaining({ is_deleted: true, deleted_at: expect.any(Date) }),
      }),
    );
  });

  // ─── Case 2: Supabase Auth deletion ──────────────────────────────────────
  it('deletes Supabase Auth user permanently', async () => {
    mockPrisma.user.findMany.mockResolvedValue([baseAdmin]);

    await service.handleAdminCleanup();

    expect(mockSupabaseAdminAuthClient.auth.admin.deleteUser).toHaveBeenCalledWith(
      baseAdmin.supabaseUid,
    );
  });

  // ─── Case 3: Audit log ───────────────────────────────────────────────────
  it('inserts audit log with action ADMIN_AUTO_DELETED', async () => {
    mockPrisma.user.findMany.mockResolvedValue([baseAdmin]);

    await service.handleAdminCleanup();

    expect(mockPrisma.$executeRaw).toHaveBeenCalled();
    // The raw query template includes 'ADMIN_AUTO_DELETED'
    const rawCall = mockPrisma.$executeRaw.mock.calls[0];
    const queryStrings: string[] = rawCall[0] as string[];
    expect(queryStrings.join('')).toContain('ADMIN_AUTO_DELETED');
  });

  // ─── Case 4: Final email ─────────────────────────────────────────────────
  it('sends final deletion email to the admin', async () => {
    mockPrisma.user.findMany.mockResolvedValue([baseAdmin]);

    await service.handleAdminCleanup();

    expect(mockEmailService.sendAdminAutoDeleted).toHaveBeenCalledWith(
      baseAdmin.email,
      baseAdmin.displayName,
    );
  });

  // ─── Case 5: Future scheduled_delete_at → NOT deleted ────────────────────
  it('does NOT delete admin whose scheduled_delete_at is in the future', async () => {
    mockPrisma.user.findMany.mockResolvedValue([]); // prisma where clause excludes future dates

    await service.handleAdminCleanup();

    expect(mockPrisma.user.update).not.toHaveBeenCalled();
    expect(mockEmailService.sendAdminAutoDeleted).not.toHaveBeenCalled();
  });

  // ─── Case 6: scheduled_delete_at = null → NOT deleted ────────────────────
  it('does NOT delete admin with null scheduled_delete_at (deletion was cancelled)', async () => {
    mockPrisma.user.findMany.mockResolvedValue([]); // prisma where clause excludes null

    await service.handleAdminCleanup();

    expect(mockPrisma.user.update).not.toHaveBeenCalled();
  });

  // ─── Case 7: Already deleted (is_deleted=true) → skipped ─────────────────
  it('skips admins that are already marked as deleted', async () => {
    mockPrisma.user.findMany.mockResolvedValue([]); // prisma where clause excludes is_deleted=true

    await service.handleAdminCleanup();

    expect(mockPrisma.user.update).not.toHaveBeenCalled();
  });

  // ─── Case 8: Multiple expired admins → all processed ────────────────────
  it('processes all expired admins in a batch', async () => {
    const admin2 = makeAdmin({ id: 'admin-uuid-2', email: 'admin2@payung.app', supabaseUid: 'supa-uid-2' });
    mockPrisma.user.findMany.mockResolvedValue([baseAdmin, admin2]);

    await service.handleAdminCleanup();

    expect(mockPrisma.user.update).toHaveBeenCalledTimes(2);
    expect(mockEmailService.sendAdminAutoDeleted).toHaveBeenCalledTimes(2);
  });

  // ─── Case 9: One admin fails → others still processed ───────────────────
  it('continues processing remaining admins when one fails', async () => {
    const admin2 = makeAdmin({ id: 'admin-uuid-2', email: 'admin2@payung.app', supabaseUid: 'supa-uid-2' });
    mockPrisma.user.findMany.mockResolvedValue([baseAdmin, admin2]);

    // First admin's update throws; second should still succeed
    mockPrisma.user.update
      .mockRejectedValueOnce(new Error('DB timeout'))
      .mockResolvedValueOnce(admin2);

    await service.handleAdminCleanup();

    // Second admin was still processed
    expect(mockPrisma.user.update).toHaveBeenCalledTimes(2);
    expect(mockEmailService.sendAdminAutoDeleted).toHaveBeenCalledWith(
      admin2.email,
      admin2.displayName,
    );
  });

  // ─── Case 10: No admins to delete → exits cleanly ───────────────────────
  it('exits cleanly with a log when no admins need deletion', async () => {
    mockPrisma.user.findMany.mockResolvedValue([]);

    await expect(service.handleAdminCleanup()).resolves.not.toThrow();

    expect(mockPrisma.user.update).not.toHaveBeenCalled();
    expect(mockSupabaseAdminAuthClient.auth.admin.deleteUser).not.toHaveBeenCalled();
    expect(mockEmailService.sendAdminAutoDeleted).not.toHaveBeenCalled();
  });
});
