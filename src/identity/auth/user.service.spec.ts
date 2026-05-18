import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { UserService } from './user.service';
import { PrismaService } from '../../common/prisma.service';

// ─── Mocks ────────────────────────────────────────────────────────────────────

const mockPrisma = {
  user: {
    findUnique: jest.fn(),
    update: jest.fn(),
  },
};

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const baseUser = {
  id: 'user-uuid',
  supabaseUid: 'supa-uid',
  email: 'admin@payung.app',
  displayName: 'สมชาย ใจดี',
  avatarUrl: null,
  phone: null,
  address: null,
  bio: null,
  role: 3,
  isActive: true,
  must_change_password: true,
  emailPreferences: true,
  createdAt: new Date('2026-05-01'),
  updatedAt: new Date('2026-05-01'),
};

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('UserService', () => {
  let service: UserService;

  beforeEach(async () => {
    jest.clearAllMocks();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        UserService,
        { provide: PrismaService, useValue: mockPrisma },
      ],
    }).compile();

    service = module.get<UserService>(UserService);
  });

  // ─── Test 1: me query includes isActive + mustChangePassword ──────────────
  it('findById returns isActive and mustChangePassword fields', async () => {
    mockPrisma.user.findUnique.mockResolvedValue(baseUser);

    const result = await service.findById('user-uuid');

    expect(result.isActive).toBe(true);
    expect(result.mustChangePassword).toBe(true);
    expect(result.email).toBe('admin@payung.app');
  });

  // ─── Test 2: completePasswordChange sets flag to false ────────────────────
  it('completePasswordChange sets must_change_password to false and returns updated user', async () => {
    const updatedUser = { ...baseUser, must_change_password: false };
    mockPrisma.user.findUnique.mockResolvedValue(baseUser);
    mockPrisma.user.update.mockResolvedValue(updatedUser);

    const result = await service.completePasswordChange('user-uuid');

    expect(result.mustChangePassword).toBe(false);
    expect(mockPrisma.user.update).toHaveBeenCalledWith({
      where: { id: 'user-uuid' },
      data: { must_change_password: false },
    });
  });

  // ─── Test 3: completePasswordChange when flag already false → BadRequest ──
  it('completePasswordChange throws BadRequestException when flag is already false', async () => {
    const alreadyChanged = { ...baseUser, must_change_password: false };
    mockPrisma.user.findUnique.mockResolvedValue(alreadyChanged);

    await expect(service.completePasswordChange('user-uuid')).rejects.toThrow(
      BadRequestException,
    );
    expect(mockPrisma.user.update).not.toHaveBeenCalled();
  });

  // ─── Test 4: last_login_at updated via updateLastLogin ────────────────────
  it('updateLastLogin calls prisma update with last_login_at = now', async () => {
    mockPrisma.user.update.mockResolvedValue(baseUser);

    const before = Date.now();
    await service.updateLastLogin('user-uuid');
    const after = Date.now();

    expect(mockPrisma.user.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'user-uuid' },
        data: expect.objectContaining({
          last_login_at: expect.any(Date),
        }),
      }),
    );

    const calledDate: Date = mockPrisma.user.update.mock.calls[0][0].data.last_login_at;
    expect(calledDate.getTime()).toBeGreaterThanOrEqual(before);
    expect(calledDate.getTime()).toBeLessThanOrEqual(after);
  });

  // ─── Test 5: completePasswordChange → NotFoundException if user missing ──
  it('completePasswordChange throws NotFoundException when user does not exist', async () => {
    mockPrisma.user.findUnique.mockResolvedValue(null);

    await expect(service.completePasswordChange('ghost-uuid')).rejects.toThrow(
      NotFoundException,
    );
  });
});
