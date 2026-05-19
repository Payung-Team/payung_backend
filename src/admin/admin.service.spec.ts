/**
 * AdminService — Unit tests for inviteAdmin (PYG-156), toggleAdminStatus (PYG-157),
 * scheduleDeleteAdmin / cancelScheduledDelete (PYG-158), and rejectKyc (JSONB reasons)
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
import { ScheduleDeleteAdminInput } from './dto/schedule-delete-admin.input';
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
  $executeRaw: jest.fn().mockResolvedValue(1),
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
  sendAdminScheduleDelete: jest.fn().mockResolvedValue(undefined),
  sendAdminCancelDelete: jest.fn().mockResolvedValue(undefined),
  sendKycRejected: jest.fn().mockResolvedValue(undefined),
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

// ─────────────────────────────────────────────────────────────────────────────
// scheduleDeleteAdmin — PYG-158
// ─────────────────────────────────────────────────────────────────────────────

describe('AdminService — scheduleDeleteAdmin', () => {
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

  const scheduledTarget = { ...targetAdminBase, isActive: true, is_deleted: false };
  const scheduledResult = { ...targetAdminBase, isActive: false };

  // ─── Case 1: Schedule delete → is_active=false + ban + email ─────────────
  it('schedules deletion: sets isActive=false, scheduled_delete_at, bans Supabase', async () => {
    mockPrisma.user.findUnique.mockResolvedValue(scheduledTarget);
    mockPrisma.user.count.mockResolvedValue(3);
    mockPrisma.user.update.mockResolvedValue(scheduledResult);

    const result = await service.scheduleDeleteAdmin(
      { adminId: 'target-admin-uuid', gracePeriodDays: 30 },
      superAdmin,
    );

    expect(result.gracePeriodDays).toBe(30);
    expect(result.scheduledDeleteAt).toBeInstanceOf(Date);
    expect(mockPrisma.user.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          isActive: false,
          deletion_scheduled_by: superAdmin.id,
        }),
      }),
    );
    expect(mockSupabaseAdminClient.auth.admin.updateUserById).toHaveBeenCalledWith(
      'supabase-target-uid',
      { ban_duration: '876000h' },
    );
  });

  // ─── Case 2: Grace period 7 days → scheduledDeleteAt = NOW + 7 ───────────
  it('sets scheduledDeleteAt to NOW + 7 days when gracePeriodDays=7', async () => {
    mockPrisma.user.findUnique.mockResolvedValue(scheduledTarget);
    mockPrisma.user.count.mockResolvedValue(3);
    mockPrisma.user.update.mockResolvedValue(scheduledResult);

    const before = new Date();
    const result = await service.scheduleDeleteAdmin(
      { adminId: 'target-admin-uuid', gracePeriodDays: 7 },
      superAdmin,
    );
    const after = new Date();

    const minExpected = new Date(before);
    minExpected.setDate(minExpected.getDate() + 7);
    const maxExpected = new Date(after);
    maxExpected.setDate(maxExpected.getDate() + 7);

    expect(result.scheduledDeleteAt.getTime()).toBeGreaterThanOrEqual(minExpected.getTime());
    expect(result.scheduledDeleteAt.getTime()).toBeLessThanOrEqual(maxExpected.getTime());
  });

  // ─── Case 3: Grace period 60 days ────────────────────────────────────────
  it('sets scheduledDeleteAt to NOW + 60 days when gracePeriodDays=60', async () => {
    mockPrisma.user.findUnique.mockResolvedValue(scheduledTarget);
    mockPrisma.user.count.mockResolvedValue(3);
    mockPrisma.user.update.mockResolvedValue(scheduledResult);

    const result = await service.scheduleDeleteAdmin(
      { adminId: 'target-admin-uuid', gracePeriodDays: 60 },
      superAdmin,
    );

    expect(result.gracePeriodDays).toBe(60);
    const diffDays = Math.round(
      (result.scheduledDeleteAt.getTime() - Date.now()) / (1000 * 60 * 60 * 24),
    );
    expect(diffDays).toBeGreaterThanOrEqual(59);
    expect(diffDays).toBeLessThanOrEqual(60);
  });

  // ─── Case 4: KYC reviews reassign — skipped (NOT NULL constraint) ─────────
  // KycReview.reviewerId is NOT NULL in schema → cannot set to null without migration
  // This test documents the known skip
  it('does NOT attempt to reassign KYC reviews (reviewerId is NOT NULL)', async () => {
    mockPrisma.user.findUnique.mockResolvedValue(scheduledTarget);
    mockPrisma.user.count.mockResolvedValue(3);
    mockPrisma.user.update.mockResolvedValue(scheduledResult);

    await service.scheduleDeleteAdmin(
      { adminId: 'target-admin-uuid', gracePeriodDays: 30 },
      superAdmin,
    );

    // kycReview.updateMany should NOT be called (reviewerId NOT NULL)
    expect(mockPrisma.kycReview.create).not.toHaveBeenCalled();
  });

  // ─── Case 5: Self-deletion → BadRequestException ──────────────────────────
  it('throws BadRequestException when trying to schedule delete self', async () => {
    await expect(
      service.scheduleDeleteAdmin(
        { adminId: superAdmin.id, gracePeriodDays: 30 },
        superAdmin,
      ),
    ).rejects.toThrow(BadRequestException);
    expect(mockPrisma.user.findUnique).not.toHaveBeenCalled();
  });

  // ─── Case 6: Last Super Admin → BadRequestException ──────────────────────
  it('throws BadRequestException when scheduling delete for last active Super Admin', async () => {
    const superAdminTarget = { ...scheduledTarget, role: ROLE_ID.SUPER_ADMIN };
    mockPrisma.user.findUnique.mockResolvedValue(superAdminTarget);
    mockPrisma.user.count.mockResolvedValue(1);

    await expect(
      service.scheduleDeleteAdmin(
        { adminId: 'target-admin-uuid', gracePeriodDays: 30 },
        superAdmin,
      ),
    ).rejects.toThrow(BadRequestException);
    expect(mockPrisma.user.update).not.toHaveBeenCalled();
  });

  // ─── Case 7: Already deleted → ConflictException ─────────────────────────
  it('throws ConflictException when target admin is already deleted', async () => {
    const deletedTarget = { ...scheduledTarget, is_deleted: true };
    mockPrisma.user.findUnique.mockResolvedValue(deletedTarget);

    await expect(
      service.scheduleDeleteAdmin(
        { adminId: 'target-admin-uuid', gracePeriodDays: 30 },
        superAdmin,
      ),
    ).rejects.toThrow(ConflictException);
  });

  // ─── Case 8: Invalid grace period (e.g., 15) → BadRequestException ───────
  it('throws BadRequestException for invalid grace period (e.g., 15)', async () => {
    mockPrisma.user.findUnique.mockResolvedValue(scheduledTarget);
    mockPrisma.user.count.mockResolvedValue(3);

    await expect(
      service.scheduleDeleteAdmin(
        { adminId: 'target-admin-uuid', gracePeriodDays: 15 },
        superAdmin,
      ),
    ).rejects.toThrow(BadRequestException);
    expect(mockPrisma.user.update).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// cancelScheduledDelete — PYG-158
// ─────────────────────────────────────────────────────────────────────────────

describe('AdminService — cancelScheduledDelete', () => {
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

  const pendingDeleteTarget = {
    ...targetAdminBase,
    isActive: false,
    is_deleted: false,
    scheduled_delete_at: new Date('2026-06-17'),
    deletion_scheduled_by: superAdmin.id,
  };

  // ─── Case 9: Cancel → reactivate + clear + unban ─────────────────────────
  it('cancels deletion: reactivates, clears scheduled_delete_at, unbans Supabase', async () => {
    const reactivatedUser = { ...targetAdminBase, isActive: true };
    mockPrisma.user.findUnique.mockResolvedValue(pendingDeleteTarget);
    mockPrisma.user.update.mockResolvedValue(reactivatedUser);

    const result = await service.cancelScheduledDelete(
      { adminId: 'target-admin-uuid' },
      superAdmin,
    );

    expect(result.reactivated).toBe(true);
    expect(result.user.isActive).toBe(true);
    expect(mockPrisma.user.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          isActive: true,
          scheduled_delete_at: null,
          deletion_scheduled_by: null,
        }),
      }),
    );
    expect(mockSupabaseAdminClient.auth.admin.updateUserById).toHaveBeenCalledWith(
      'supabase-target-uid',
      { ban_duration: 'none' },
    );
  });

  // ─── Case 10: No scheduled deletion → BadRequestException ────────────────
  it('throws BadRequestException when target has no scheduled deletion', async () => {
    const noSchedule = { ...targetAdminBase, scheduled_delete_at: null };
    mockPrisma.user.findUnique.mockResolvedValue(noSchedule);

    await expect(
      service.cancelScheduledDelete({ adminId: 'target-admin-uuid' }, superAdmin),
    ).rejects.toThrow(BadRequestException);
    expect(mockPrisma.user.update).not.toHaveBeenCalled();
  });

  // ─── Case 11: Already deleted → ConflictException ────────────────────────
  it('throws ConflictException when target is already permanently deleted', async () => {
    const alreadyDeleted = {
      ...pendingDeleteTarget,
      is_deleted: true,
      deleted_at: new Date('2026-06-01'),
    };
    mockPrisma.user.findUnique.mockResolvedValue(alreadyDeleted);

    await expect(
      service.cancelScheduledDelete({ adminId: 'target-admin-uuid' }, superAdmin),
    ).rejects.toThrow(ConflictException);
  });
});

// ─── rejectKyc — JSONB multiple reasons ──────────────────────────────────────

describe('AdminService — rejectKyc', () => {
  let service: AdminService;

  const adminUser: AuthUser = {
    id: 'admin-uuid',
    supabaseUid: 'supabase-admin-uid',
    email: 'admin@payung.app',
    role: ROLE_ID.ADMIN,
    isSuspended: false,
  };

  const pendingCaregiver = {
    id: 'cg-uuid',
    userId: 'user-uuid',
    caregiverNumber: 'CG-001',
    fullName: 'สมหญิง รักดี',
    idCardNumber: '1234567890123',
    gender: 'female',
    dateOfBirth: new Date('1990-01-01'),
    address: 'Bangkok',
    phone: '0812345678',
    skills: ['elder_care'],
    experienceYears: 3,
    hourlyRate: 150,
    bio: null,
    kycStatus: 'pending',
    kycSubmittedAt: new Date('2026-05-01'),
    kycVerifiedAt: null,
    isSearchable: false,
    resubmitCount: 0,
    rejection_reasons: null,
    createdAt: new Date('2026-04-01'),
    updatedAt: new Date('2026-05-01'),
  };

  const reasons = [
    { title: 'เอกสารไม่ชัดเจน', detail: 'กรุณาถ่ายรูปให้ชัดขึ้น', documentType: 'id_card_photo' },
    { title: 'ข้อมูลไม่ตรงกัน' },
  ];

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

  // ─── Case 1: Success — stores JSONB reasons and returns updated caregiver ──
  it('rejects KYC, stores rejection_reasons as JSONB, returns caregiver', async () => {
    const updatedCg = { ...pendingCaregiver, kycStatus: 'rejected', rejection_reasons: reasons };
    mockPrisma.caregiver.findUnique.mockResolvedValue(pendingCaregiver);
    mockPrisma.$transaction.mockImplementation(async (fn: (tx: typeof mockPrisma) => Promise<unknown>) => fn(mockPrisma));
    mockPrisma.caregiver.update.mockResolvedValue(updatedCg);
    mockPrisma.kycReview.create.mockResolvedValue({});
    mockNotificationService.create.mockResolvedValue(undefined);

    const result = await service.rejectKyc({ caregiverId: 'cg-uuid', reasons }, adminUser);

    expect(result.kycStatus).toBe('rejected');
    expect(result.rejectionReasons).toEqual(reasons);
    expect(mockPrisma.caregiver.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          kycStatus: 'rejected',
          rejection_reasons: reasons,
        }),
      }),
    );
  });

  // ─── Case 2: KycReview.reason is joined titles ────────────────────────────
  it('writes joined titles as KycReview.reason', async () => {
    const updatedCg = { ...pendingCaregiver, kycStatus: 'rejected', rejection_reasons: reasons };
    mockPrisma.caregiver.findUnique.mockResolvedValue(pendingCaregiver);
    mockPrisma.$transaction.mockImplementation(async (fn: (tx: typeof mockPrisma) => Promise<unknown>) => fn(mockPrisma));
    mockPrisma.caregiver.update.mockResolvedValue(updatedCg);
    mockPrisma.kycReview.create.mockResolvedValue({});

    await service.rejectKyc({ caregiverId: 'cg-uuid', reasons }, adminUser);

    expect(mockPrisma.kycReview.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          reason: 'เอกสารไม่ชัดเจน; ข้อมูลไม่ตรงกัน',
        }),
      }),
    );
  });

  // ─── Case 3: Empty reasons array → BadRequestException ───────────────────
  it('throws BadRequestException when reasons array is empty', async () => {
    await expect(
      service.rejectKyc({ caregiverId: 'cg-uuid', reasons: [] }, adminUser),
    ).rejects.toThrow(BadRequestException);
    expect(mockPrisma.caregiver.findUnique).not.toHaveBeenCalled();
  });

  // ─── Case 4: Caregiver not found → NotFoundException ─────────────────────
  it('throws NotFoundException when caregiver does not exist', async () => {
    mockPrisma.caregiver.findUnique.mockResolvedValue(null);

    await expect(
      service.rejectKyc({ caregiverId: 'ghost-uuid', reasons }, adminUser),
    ).rejects.toThrow(NotFoundException);
  });

  // ─── Case 5: kycStatus = 'none' → BadRequestException ────────────────────
  it('throws BadRequestException when kycStatus is "none"', async () => {
    mockPrisma.caregiver.findUnique.mockResolvedValue({ ...pendingCaregiver, kycStatus: 'none' });

    await expect(
      service.rejectKyc({ caregiverId: 'cg-uuid', reasons }, adminUser),
    ).rejects.toThrow(BadRequestException);
  });

  // ─── Case 6: kycStatus = 'verified' → ConflictException ──────────────────
  it('throws ConflictException when kycStatus is already "verified"', async () => {
    mockPrisma.caregiver.findUnique.mockResolvedValue({ ...pendingCaregiver, kycStatus: 'verified' });

    await expect(
      service.rejectKyc({ caregiverId: 'cg-uuid', reasons }, adminUser),
    ).rejects.toThrow(ConflictException);
  });

  // ─── Case 7: kycStatus = 'rejected' → ConflictException ──────────────────
  it('throws ConflictException when kycStatus is already "rejected"', async () => {
    mockPrisma.caregiver.findUnique.mockResolvedValue({ ...pendingCaregiver, kycStatus: 'rejected' });

    await expect(
      service.rejectKyc({ caregiverId: 'cg-uuid', reasons }, adminUser),
    ).rejects.toThrow(ConflictException);
  });

  // ─── Case 8: Single reason (no detail/documentType) ──────────────────────
  it('handles single reason with title only', async () => {
    const singleReason = [{ title: 'รูปไม่ชัด' }];
    const updatedCg = { ...pendingCaregiver, kycStatus: 'rejected', rejection_reasons: singleReason };
    mockPrisma.caregiver.findUnique.mockResolvedValue(pendingCaregiver);
    mockPrisma.$transaction.mockImplementation(async (fn: (tx: typeof mockPrisma) => Promise<unknown>) => fn(mockPrisma));
    mockPrisma.caregiver.update.mockResolvedValue(updatedCg);
    mockPrisma.kycReview.create.mockResolvedValue({});

    const result = await service.rejectKyc({ caregiverId: 'cg-uuid', reasons: singleReason }, adminUser);

    expect(result.rejectionReasons).toEqual(singleReason);
    expect(mockPrisma.kycReview.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ reason: 'รูปไม่ชัด' }),
      }),
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// editAdminInfo — PYG-160
// ─────────────────────────────────────────────────────────────────────────────

describe('AdminService — editAdminInfo', () => {
  let service: AdminService;

  const editTarget = { ...targetAdminBase }; // role=3, is_deleted=false, displayName='สมหญิง รักดี'

  beforeEach(async () => {
    jest.clearAllMocks();
    mockSupabaseAdminClient.auth.admin.updateUserById.mockResolvedValue({ error: null });
    mockPrisma.$executeRaw.mockResolvedValue(1);

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

  // ─── Case 1: Edit name only → displayName updated, Supabase NOT called ───
  it('updates displayName when firstName/lastName provided, does not call Supabase', async () => {
    mockPrisma.user.findUnique.mockResolvedValue(editTarget);
    const updated = { ...editTarget, displayName: 'สมชาย ใจดี' };
    mockPrisma.user.update.mockResolvedValue(updated);

    const result = await service.editAdminInfo(
      { adminId: 'target-admin-uuid', firstName: 'สมชาย', lastName: 'ใจดี' },
      superAdmin,
    );

    expect(result.user.displayName).toBe('สมชาย ใจดี');
    expect(mockPrisma.user.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ displayName: 'สมชาย ใจดี' }),
      }),
    );
    expect(mockSupabaseAdminClient.auth.admin.updateUserById).not.toHaveBeenCalled();
  });

  // ─── Case 2: Edit email → DB + Supabase Auth updated ─────────────────────
  it('updates email in DB and syncs Supabase Auth when email changes', async () => {
    mockPrisma.user.findUnique
      .mockResolvedValueOnce(editTarget)       // find target
      .mockResolvedValueOnce(null);            // email uniqueness check → available
    const updated = { ...editTarget, email: 'newemail@payung.app' };
    mockPrisma.user.update.mockResolvedValue(updated);

    const result = await service.editAdminInfo(
      { adminId: 'target-admin-uuid', email: 'newemail@payung.app' },
      superAdmin,
    );

    expect(result.user.email).toBe('newemail@payung.app');
    expect(mockPrisma.user.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ email: 'newemail@payung.app' }),
      }),
    );
    expect(mockSupabaseAdminClient.auth.admin.updateUserById).toHaveBeenCalledWith(
      'supabase-target-uid',
      { email: 'newemail@payung.app' },
    );
  });

  // ─── Case 3: Edit role 3→4 → role updated ────────────────────────────────
  it('promotes admin from ADMIN(3) to SUPER_ADMIN(4)', async () => {
    mockPrisma.user.findUnique.mockResolvedValue(editTarget);
    const updated = { ...editTarget, role: ROLE_ID.SUPER_ADMIN };
    mockPrisma.user.update.mockResolvedValue(updated);

    const result = await service.editAdminInfo(
      { adminId: 'target-admin-uuid', role: ROLE_ID.SUPER_ADMIN },
      superAdmin,
    );

    expect(result.user.role).toBe(ROLE_ID.SUPER_ADMIN);
    expect(mockPrisma.user.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ role: ROLE_ID.SUPER_ADMIN }),
      }),
    );
  });

  // ─── Case 4: Edit multiple fields at once ────────────────────────────────
  it('updates name, email, and role together in a single call', async () => {
    mockPrisma.user.findUnique
      .mockResolvedValueOnce(editTarget)
      .mockResolvedValueOnce(null); // email uniqueness
    const updated = {
      ...editTarget,
      displayName: 'ใหม่ มาก',
      email: 'multi@payung.app',
      role: ROLE_ID.SUPER_ADMIN,
    };
    mockPrisma.user.update.mockResolvedValue(updated);

    const result = await service.editAdminInfo(
      {
        adminId: 'target-admin-uuid',
        firstName: 'ใหม่',
        lastName: 'มาก',
        email: 'multi@payung.app',
        role: ROLE_ID.SUPER_ADMIN,
      },
      superAdmin,
    );

    expect(result.user.displayName).toBe('ใหม่ มาก');
    expect(result.user.email).toBe('multi@payung.app');
    expect(result.user.role).toBe(ROLE_ID.SUPER_ADMIN);
  });

  // ─── Case 5: Duplicate email → ConflictException ─────────────────────────
  it('throws ConflictException when the new email is already taken', async () => {
    mockPrisma.user.findUnique
      .mockResolvedValueOnce(editTarget)
      .mockResolvedValueOnce({ id: 'other-user-uuid' }); // email already taken

    await expect(
      service.editAdminInfo(
        { adminId: 'target-admin-uuid', email: 'taken@payung.app' },
        superAdmin,
      ),
    ).rejects.toThrow(ConflictException);
    expect(mockPrisma.user.update).not.toHaveBeenCalled();
  });

  // ─── Case 6: Demote last Super Admin (4→3) → BadRequestException ─────────
  it('throws BadRequestException when demoting the last active Super Admin', async () => {
    const superAdminTarget = { ...editTarget, role: ROLE_ID.SUPER_ADMIN };
    mockPrisma.user.findUnique.mockResolvedValue(superAdminTarget);
    mockPrisma.user.count.mockResolvedValue(1); // only 1 active super admin

    await expect(
      service.editAdminInfo(
        { adminId: 'target-admin-uuid', role: ROLE_ID.ADMIN },
        superAdmin,
      ),
    ).rejects.toThrow(BadRequestException);
    expect(mockPrisma.user.update).not.toHaveBeenCalled();
  });

  // ─── Case 7: Invalid role → BadRequestException ───────────────────────────
  it.each([
    [1, 'patient'],
    [2, 'caregiver'],
  ])('throws BadRequestException for invalid role=%i (%s)', async (invalidRole, _label) => {
    mockPrisma.user.findUnique.mockResolvedValue(editTarget);

    await expect(
      service.editAdminInfo(
        { adminId: 'target-admin-uuid', role: invalidRole },
        superAdmin,
      ),
    ).rejects.toThrow(BadRequestException);
    expect(mockPrisma.user.update).not.toHaveBeenCalled();
  });

  // ─── Case 8: Target not found → NotFoundException ────────────────────────
  it('throws NotFoundException when target admin does not exist', async () => {
    mockPrisma.user.findUnique.mockResolvedValue(null);

    await expect(
      service.editAdminInfo({ adminId: 'nonexistent-uuid', firstName: 'Test' }, superAdmin),
    ).rejects.toThrow(NotFoundException);
  });

  it('throws NotFoundException when target user is not an admin (role < 3)', async () => {
    mockPrisma.user.findUnique.mockResolvedValue({ ...editTarget, role: ROLE_ID.PATIENT });

    await expect(
      service.editAdminInfo({ adminId: 'target-admin-uuid', firstName: 'Test' }, superAdmin),
    ).rejects.toThrow(NotFoundException);
  });

  // ─── Case 9: Target is deleted → ConflictException ───────────────────────
  it('throws ConflictException when target admin is already soft-deleted', async () => {
    mockPrisma.user.findUnique.mockResolvedValue({ ...editTarget, is_deleted: true });

    await expect(
      service.editAdminInfo({ adminId: 'target-admin-uuid', firstName: 'Test' }, superAdmin),
    ).rejects.toThrow(ConflictException);
    expect(mockPrisma.user.update).not.toHaveBeenCalled();
  });

  // ─── Case 10: Audit log — $executeRaw called after update ────────────────
  it('fires $executeRaw for audit log after a successful update', async () => {
    mockPrisma.user.findUnique
      .mockResolvedValueOnce(editTarget)
      .mockResolvedValueOnce(null);
    mockPrisma.user.update.mockResolvedValue({ ...editTarget, email: 'audit@payung.app' });

    await service.editAdminInfo(
      { adminId: 'target-admin-uuid', email: 'audit@payung.app' },
      superAdmin,
    );

    expect(mockPrisma.$executeRaw).toHaveBeenCalled();
  });

  // ─── Case 11: No fields provided → no-op, still succeeds ─────────────────
  it('succeeds without changing anything when no fields are provided', async () => {
    mockPrisma.user.findUnique.mockResolvedValue(editTarget);
    mockPrisma.user.update.mockResolvedValue(editTarget);

    const result = await service.editAdminInfo(
      { adminId: 'target-admin-uuid' },
      superAdmin,
    );

    expect(result.user.id).toBe('target-admin-uuid');
    expect(mockPrisma.user.update).toHaveBeenCalled();
    expect(mockSupabaseAdminClient.auth.admin.updateUserById).not.toHaveBeenCalled();
  });
});
