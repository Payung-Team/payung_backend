/**
 * AdminService — Unit tests for inviteAdmin (PYG-156)
 *
 * Cases 5 & 6 (non-super-admin / inactive admin → ForbiddenException) are enforced
 * by RolesGuard + SupabaseAuthGuard at the resolver layer, not by AdminService.
 * Those guards are unit-tested separately.
 */
import { Test, TestingModule } from '@nestjs/testing';
import { ConflictException, BadRequestException, InternalServerErrorException } from '@nestjs/common';
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
    },
  },
};

const mockSupabase = {
  getAdminClient: jest.fn(() => mockSupabaseAdminClient),
};

const mockEmailService = {
  sendAdminInvite: jest.fn().mockResolvedValue(undefined),
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
