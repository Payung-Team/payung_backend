/**
 * AdminService — Unit tests for inviteAdmin (PYG-156) and toggleAdminStatus (PYG-157)
 *
 * ForbiddenException cases (non-super-admin / inactive admin) are enforced
 * by RolesGuard + SupabaseAuthGuard at the resolver layer, not by AdminService.
 */
import { Test, TestingModule } from '@nestjs/testing';
import {
  ConflictException,
  BadRequestException,
  InternalServerErrorException,
  NotFoundException,
} from '@nestjs/common';
import { AdminService } from './admin.service';
import { PrismaService } from '../common/prisma.service';
import { SupabaseService } from '../common/supabase.service';
import { EmailService } from '../email/email.service';
import { CaregiverService } from '../identity/kyc/caregiver.service';
import { NotificationService } from '../notification/notification.service';
import { AuthUser } from '../common/decorators/current-user.decorator';
import { ROLE_ID } from '../common/constants/roles.constant';

// ─── Mocks ───────────────────────────────────────────────────────────────────

const mockPrisma = {
  user: {
    findUnique: jest.fn(),
    create: jest.fn(),
    update: jest.fn(),
    count: jest.fn(),
  },
  caregiver: {
    findMany: jest.fn(),
    count: jest.fn(),
    findUnique: jest.fn(),
    update: jest.fn(),
  },
  kycReview: {
    findMany: jest.fn(),
    create: jest.fn(),
  },
  $transaction: jest.fn(),
};

const mockSupabaseAdminClient = {
  auth: {
    admin: {
      createUser: jest.fn(),
      updateUserById: jest.fn().mockResolvedValue({ error: null }),
    },
  },
};

const mockSupabase = {
  getAdminClient: jest.fn(() => mockSupabaseAdminClient),
};

const mockEmailService = {
  sendAdminInvite: jest.fn().mockResolvedValue(undefined),
  sendAdminDeactivated: jest.fn().mockResolvedValue(undefined),
  sendAdminActivated: jest.fn().mockResolvedValue(undefined),
};

const mockCaregiverService = {
  getDocumentsWithSignedUrls: jest.fn(),
};

const mockNotificationService = {
  create: jest.fn(),
};

// ─── Fixtures ────────────────────────────────────────────────────────────────

const superAdmin: AuthUser = {
  id: 'super-admin-uuid',
  supabaseUid: 'supabase-super-uid',
  email: 'super@payung.app',
  role: ROLE_ID.SUPER_ADMIN,
  isSuspended: false,
};

const createdUserBase = {
  id: 'new-user-uuid',
  supabaseUid: 'supabase-new-uid',
  email: 'newadmin@payung.app',
  displayName: 'สมชาย ใจดี',
  avatarUrl: null,
  phone: null,
  address: null,
  bio: null,
  isActive: true,
  emailPreferences: true,
  must_change_password: true,
  invited_by: superAdmin.id,
  is_deleted: false,
  last_login_at: null,
  scheduled_delete_at: null,
  deletion_scheduled_by: null,
  deleted_at: null,
  role: ROLE_ID.ADMIN,
  createdAt: new Date('2026-05-16'),
  updatedAt: new Date('2026-05-16'),
};

const inviteAdminInput = {
  email: 'newadmin@payung.app',
  firstName: 'สมชาย',
  lastName: 'ใจดี',
  role: ROLE_ID.ADMIN,
};

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('AdminService — inviteAdmin', () => {
  let service: AdminService;

  beforeEach(async () => {
    jest.clearAllMocks();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AdminService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: SupabaseService, useValue: mockSupabase },
        { provide: EmailService, useValue: mockEmailService },
        { provide: CaregiverService, useValue: mockCaregiverService },
        { provide: NotificationService, useValue: mockNotificationService },
      ],
    }).compile();

    service = module.get<AdminService>(AdminService);
  });

  // ─── Case 1: Successfully invite admin (role=3) ───────────────────────────
  it('creates admin (role=3) and returns tempPasswordSent=true', async () => {
    mockPrisma.user.findUnique.mockResolvedValue(null);
    mockSupabaseAdminClient.auth.admin.createUser.mockResolvedValue({
      data: { user: { id: 'supabase-new-uid' } },
      error: null,
    });
    mockPrisma.user.create.mockResolvedValue(createdUserBase);

    const result = await service.inviteAdmin(inviteAdminInput, superAdmin);

    expect(result.tempPasswordSent).toBe(true);
    expect(result.user.email).toBe('newadmin@payung.app');
    expect(result.user.role).toBe(ROLE_ID.ADMIN);
    expect(mockPrisma.user.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          email: 'newadmin@payung.app',
          role: ROLE_ID.ADMIN,
          must_change_password: true,
          invited_by: superAdmin.id,
        }),
      }),
    );
    expect(mockSupabaseAdminClient.auth.admin.createUser).toHaveBeenCalledWith(
      expect.objectContaining({ email: 'newadmin@payung.app', email_confirm: true }),
    );
  });

  // ─── Case 2: Successfully invite super admin (role=4) ────────────────────
  it('creates super admin (role=4) successfully', async () => {
    const superAdminInput = { ...inviteAdminInput, role: ROLE_ID.SUPER_ADMIN };
    const createdSuperAdmin = { ...createdUserBase, role: ROLE_ID.SUPER_ADMIN };

    mockPrisma.user.findUnique.mockResolvedValue(null);
    mockSupabaseAdminClient.auth.admin.createUser.mockResolvedValue({
      data: { user: { id: 'supabase-new-uid' } },
      error: null,
    });
    mockPrisma.user.create.mockResolvedValue(createdSuperAdmin);

    const result = await service.inviteAdmin(superAdminInput, superAdmin);

    expect(result.user.role).toBe(ROLE_ID.SUPER_ADMIN);
    expect(result.tempPasswordSent).toBe(true);
  });

  // ─── Case 3: Duplicate email → ConflictException ─────────────────────────
  it('throws ConflictException when email is already registered', async () => {
    mockPrisma.user.findUnique.mockResolvedValue({ id: 'existing-user-id' });

    await expect(service.inviteAdmin(inviteAdminInput, superAdmin)).rejects.toThrow(
      ConflictException,
    );
    expect(mockSupabaseAdminClient.auth.admin.createUser).not.toHaveBeenCalled();
    expect(mockPrisma.user.create).not.toHaveBeenCalled();
  });

  // ─── Case 4: Invalid role (1 or 2) → BadRequestException ─────────────────
  it.each([
    [ROLE_ID.PATIENT, 'patient'],
    [ROLE_ID.CAREGIVER, 'caregiver'],
  ])('throws BadRequestException for invalid role=%i (%s)', async (invalidRole, _label) => {
    const badInput = { ...inviteAdminInput, role: invalidRole };
    mockPrisma.user.findUnique.mockResolvedValue(null);

    await expect(service.inviteAdmin(badInput, superAdmin)).rejects.toThrow(BadRequestException);
    expect(mockSupabaseAdminClient.auth.admin.createUser).not.toHaveBeenCalled();
  });

  // ─── Case 5: Supabase Auth failure → InternalServerErrorException ─────────
  it('throws InternalServerErrorException when Supabase auth.admin.createUser fails', async () => {
    mockPrisma.user.findUnique.mockResolvedValue(null);
    mockSupabaseAdminClient.auth.admin.createUser.mockResolvedValue({
      data: { user: null },
      error: { message: 'Supabase error' },
    });

    await expect(service.inviteAdmin(inviteAdminInput, superAdmin)).rejects.toThrow(
      InternalServerErrorException,
    );
    expect(mockPrisma.user.create).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// toggleAdminStatus — PYG-157
// ─────────────────────────────────────────────────────────────────────────────

const targetAdminBase = {
  id: 'target-admin-uuid',
  supabaseUid: 'supabase-target-uid',
  email: 'admin@payung.app',
  displayName: 'สมหญิง รักดี',
  avatarUrl: null,
  phone: null,
  address: null,
  bio: null,
  isActive: true,
  emailPreferences: true,
  role: ROLE_ID.ADMIN,
  must_change_password: false,
  invited_by: null,
  is_deleted: false,
  last_login_at: null,
  scheduled_delete_at: null,
  deletion_scheduled_by: null,
  deleted_at: null,
  createdAt: new Date('2026-05-17'),
  updatedAt: new Date('2026-05-17'),
};

describe('AdminService — toggleAdminStatus', () => {
  let service: AdminService;

  beforeEach(async () => {
    jest.clearAllMocks();
    mockSupabaseAdminClient.auth.admin.updateUserById.mockResolvedValue({ error: null });

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AdminService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: SupabaseService, useValue: mockSupabase },
        { provide: EmailService, useValue: mockEmailService },
        { provide: CaregiverService, useValue: mockCaregiverService },
        { provide: NotificationService, useValue: mockNotificationService },
      ],
    }).compile();

    service = module.get<AdminService>(AdminService);
  });

  // ─── Case 1: Deactivate admin → is_active=false + sessions banned + email ──
  it('deactivates admin: updates isActive=false, bans Supabase session, sends email', async () => {
    const deactivated = { ...targetAdminBase, isActive: false };
    mockPrisma.user.findUnique.mockResolvedValue(targetAdminBase);
    mockPrisma.user.update.mockResolvedValue(deactivated);

    const result = await service.toggleAdminStatus(
      { adminId: 'target-admin-uuid', isActive: false },
      superAdmin,
    );

    expect(result.action).toBe('ADMIN_DEACTIVATED');
    expect(result.user.isActive).toBe(false);
    expect(mockPrisma.user.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ isActive: false }),
      }),
    );
    expect(mockSupabaseAdminClient.auth.admin.updateUserById).toHaveBeenCalledWith(
      'supabase-target-uid',
      { ban_duration: '876000h' },
    );
  });

  // ─── Case 2: Activate admin → is_active=true + unban ────────────────────
  it('activates admin: updates isActive=true and unbans Supabase session', async () => {
    const inactiveTarget = { ...targetAdminBase, isActive: false };
    const activated = { ...targetAdminBase, isActive: true };
    mockPrisma.user.findUnique.mockResolvedValue(inactiveTarget);
    mockPrisma.user.update.mockResolvedValue(activated);

    const result = await service.toggleAdminStatus(
      { adminId: 'target-admin-uuid', isActive: true },
      superAdmin,
    );

    expect(result.action).toBe('ADMIN_ACTIVATED');
    expect(result.user.isActive).toBe(true);
    expect(mockSupabaseAdminClient.auth.admin.updateUserById).toHaveBeenCalledWith(
      'supabase-target-uid',
      { ban_duration: 'none' },
    );
  });

  // ─── Case 3: Activate → clears scheduled_delete_at ──────────────────────
  it('clears scheduled_delete_at when activating an admin with pending deletion', async () => {
    const pendingDelete = {
      ...targetAdminBase,
      isActive: false,
      scheduled_delete_at: new Date('2026-06-01'),
      deletion_scheduled_by: superAdmin.id,
    };
    mockPrisma.user.findUnique.mockResolvedValue(pendingDelete);
    mockPrisma.user.update.mockResolvedValue({ ...targetAdminBase, isActive: true });

    await service.toggleAdminStatus(
      { adminId: 'target-admin-uuid', isActive: true },
      superAdmin,
    );

    expect(mockPrisma.user.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          isActive: true,
          scheduled_delete_at: null,
          deletion_scheduled_by: null,
        }),
      }),
    );
  });

  // ─── Case 4: Self-deactivation → BadRequestException ────────────────────
  it('throws BadRequestException when trying to deactivate self', async () => {
    await expect(
      service.toggleAdminStatus(
        { adminId: superAdmin.id, isActive: false },
        superAdmin,
      ),
    ).rejects.toThrow(BadRequestException);
    expect(mockPrisma.user.findUnique).not.toHaveBeenCalled();
  });

  // ─── Case 5: Deactivate last Super Admin → BadRequestException ───────────
  it('throws BadRequestException when deactivating the last active Super Admin', async () => {
    const superAdminTarget = { ...targetAdminBase, role: ROLE_ID.SUPER_ADMIN };
    mockPrisma.user.findUnique.mockResolvedValue(superAdminTarget);
    mockPrisma.user.count.mockResolvedValue(1); // only 1 active super admin left

    await expect(
      service.toggleAdminStatus(
        { adminId: 'target-admin-uuid', isActive: false },
        superAdmin,
      ),
    ).rejects.toThrow(BadRequestException);
    expect(mockPrisma.user.update).not.toHaveBeenCalled();
  });

  // ─── Case 6: Target not found / not admin → NotFoundException ────────────
  it('throws NotFoundException when target user is not found', async () => {
    mockPrisma.user.findUnique.mockResolvedValue(null);

    await expect(
      service.toggleAdminStatus(
        { adminId: 'nonexistent-uuid', isActive: false },
        superAdmin,
      ),
    ).rejects.toThrow(NotFoundException);
  });

  it('throws NotFoundException when target user is not an admin (role < 3)', async () => {
    const patientUser = { ...targetAdminBase, role: ROLE_ID.PATIENT };
    mockPrisma.user.findUnique.mockResolvedValue(patientUser);

    await expect(
      service.toggleAdminStatus(
        { adminId: 'target-admin-uuid', isActive: false },
        superAdmin,
      ),
    ).rejects.toThrow(NotFoundException);
  });
});
