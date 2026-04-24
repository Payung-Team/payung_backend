/**
 * kyc-resubmit.service.spec.ts — Unit tests สำหรับ KycService.resubmitKyc()
 *
 * Test cases:
 * 1. Happy path — status = 'rejected' → resubmit สำเร็จ + notification + resubmitCount++
 * 2. status = 'none'     → BadRequestException
 * 3. status = 'pending'  → ConflictException
 * 4. status = 'verified' → ConflictException
 * 5. Document validation — doc ไม่ใช่ของ user → NotFoundException
 * 6. Notification fire-and-forget — resubmit สำเร็จแม้ notification ล้มเหลว
 * 7. resubmitCount increment — แต่ละ resubmit เพิ่ม count ถูกต้อง
 */
import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { KycService } from './kyc.service';
import { PrismaService } from '../../common/prisma.service';
import { CaregiverService } from './caregiver.service';
import { NotificationService } from '../../notification/notification.service';
import { NotificationType } from '../../notification/entities/notification-type.enum';

// ─── Fixtures ───────────────────────────────────────────────────────────────

const USER_ID = 'user-uuid-001';
const CAREGIVER_ID = 'caregiver-uuid-001';

const MOCK_INPUT = {
  fullName: 'สมชาย ใจดี',
  idCardNumber: '1234567890123',
  phone: '0812345678',
  skills: ['elder_care'],
  experienceYears: 3,
  hourlyRate: 150,
  bio: 'มีประสบการณ์',
  documentIds: ['doc-uuid-001', 'doc-uuid-002'],
};

const MOCK_AUTH_USER = { id: USER_ID, email: 'test@example.com', role: 2 };

function makeCaregiver(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: CAREGIVER_ID,
    userId: USER_ID,
    fullName: 'สมชาย ใจดี',
    idCardNumber: '1234567890123',
    phone: '0812345678',
    skills: ['elder_care'],
    experienceYears: 3,
    hourlyRate: 150,
    bio: null,
    kycStatus: 'rejected',
    kycSubmittedAt: new Date('2025-01-01T00:00:00Z'),
    kycVerifiedAt: null,
    isSearchable: false,
    resubmitCount: 0,
    createdAt: new Date('2025-01-01T00:00:00Z'),
    updatedAt: new Date('2025-01-01T00:00:00Z'),
    ...overrides,
  };
}

// ─── Mock factories ─────────────────────────────────────────────────────────

function createMockPrisma() {
  return {
    caregiver: {
      findUnique: jest.fn(),
      update: jest.fn(),
    },
    kycDocument: {
      findMany: jest.fn(),
      updateMany: jest.fn(),
    },
    kycReview: {
      findFirst: jest.fn(),
    },
    $transaction: jest.fn(),
  };
}

function createMockCaregiverService() {
  return {
    getDocumentsWithSignedUrls: jest.fn().mockResolvedValue([]),
  };
}

function createMockNotificationService() {
  return {
    create: jest.fn().mockResolvedValue({}),
  };
}

// ─── Test Suite ─────────────────────────────────────────────────────────────

describe('KycService.resubmitKyc()', () => {
  let service: KycService;
  let prisma: ReturnType<typeof createMockPrisma>;
  let notificationService: ReturnType<typeof createMockNotificationService>;

  beforeEach(async () => {
    prisma = createMockPrisma();
    const caregiverService = createMockCaregiverService();
    notificationService = createMockNotificationService();

    // ตั้งค่า $transaction ให้รัน callback จริง (execute inline)
    prisma.$transaction.mockImplementation((cb: (tx: unknown) => Promise<unknown>) =>
      cb(prisma),
    );

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        KycService,
        { provide: PrismaService, useValue: prisma },
        { provide: CaregiverService, useValue: caregiverService },
        { provide: NotificationService, useValue: notificationService },
      ],
    }).compile();

    service = module.get<KycService>(KycService);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  // ─── Happy path ───────────────────────────────────────────────────────────

  describe('happy path (status: rejected)', () => {
    it('resubmit สำเร็จ — คืน Caregiver ที่มี status = pending', async () => {
      // Arrange
      const existing = makeCaregiver({ kycStatus: 'rejected', resubmitCount: 1 });
      const updated = makeCaregiver({
        kycStatus: 'pending',
        resubmitCount: 2,
        kycSubmittedAt: new Date(),
        kycVerifiedAt: null,
      });

      prisma.caregiver.findUnique.mockResolvedValue(existing);
      // doc validation
      prisma.kycDocument.findMany.mockResolvedValue(
        MOCK_INPUT.documentIds.map((id) => ({ id })),
      );
      prisma.caregiver.update.mockResolvedValue(updated);
      prisma.kycDocument.updateMany.mockResolvedValue({ count: 2 });

      // Act
      const result = await service.resubmitKyc(MOCK_AUTH_USER as any, MOCK_INPUT as any);

      // Assert
      expect(result.kycStatus).toBe('pending');
      expect(result.id).toBe(CAREGIVER_ID);
    });

    it('increment resubmitCount — update ถูก call ด้วย resubmitCount: { increment: 1 }', async () => {
      const existing = makeCaregiver({ kycStatus: 'rejected' });
      const updated = makeCaregiver({ kycStatus: 'pending', resubmitCount: 1 });

      prisma.caregiver.findUnique.mockResolvedValue(existing);
      prisma.kycDocument.findMany.mockResolvedValue(
        MOCK_INPUT.documentIds.map((id) => ({ id })),
      );
      prisma.caregiver.update.mockResolvedValue(updated);
      prisma.kycDocument.updateMany.mockResolvedValue({ count: 2 });

      await service.resubmitKyc(MOCK_AUTH_USER as any, MOCK_INPUT as any);

      expect(prisma.caregiver.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            kycStatus: 'pending',
            kycVerifiedAt: null,
            resubmitCount: { increment: 1 },
          }),
        }),
      );
    });

    it('link document_ids ใหม่ → caregiverId', async () => {
      const existing = makeCaregiver({ kycStatus: 'rejected' });
      const updated = makeCaregiver({ kycStatus: 'pending', resubmitCount: 1 });

      prisma.caregiver.findUnique.mockResolvedValue(existing);
      prisma.kycDocument.findMany.mockResolvedValue(
        MOCK_INPUT.documentIds.map((id) => ({ id })),
      );
      prisma.caregiver.update.mockResolvedValue(updated);
      prisma.kycDocument.updateMany.mockResolvedValue({ count: 2 });

      await service.resubmitKyc(MOCK_AUTH_USER as any, MOCK_INPUT as any);

      expect(prisma.kycDocument.updateMany).toHaveBeenCalledWith({
        where: {
          id: { in: MOCK_INPUT.documentIds },
          userId: USER_ID,
        },
        data: { caregiverId: CAREGIVER_ID },
      });
    });

    it('fire kyc_resubmitted notification หลัง transaction สำเร็จ', async () => {
      const existing = makeCaregiver({ kycStatus: 'rejected' });
      const updated = makeCaregiver({ kycStatus: 'pending', resubmitCount: 2 });

      prisma.caregiver.findUnique.mockResolvedValue(existing);
      prisma.kycDocument.findMany.mockResolvedValue(
        MOCK_INPUT.documentIds.map((id) => ({ id })),
      );
      prisma.caregiver.update.mockResolvedValue(updated);
      prisma.kycDocument.updateMany.mockResolvedValue({ count: 2 });

      await service.resubmitKyc(MOCK_AUTH_USER as any, MOCK_INPUT as any);

      // รอ microtask queue ก่อนตรวจ notification (fire-and-forget)
      await Promise.resolve();

      expect(notificationService.create).toHaveBeenCalledWith(
        USER_ID,
        NotificationType.kyc_resubmitted,
        expect.any(String),
        expect.any(String),
        { caregiverId: CAREGIVER_ID, resubmitCount: 2 },
      );
    });
  });

  // ─── Status guard errors ──────────────────────────────────────────────────

  describe('status guard', () => {
    it('status = "none" → BadRequestException', async () => {
      prisma.caregiver.findUnique.mockResolvedValue(null);

      await expect(
        service.resubmitKyc(MOCK_AUTH_USER as any, MOCK_INPUT as any),
      ).rejects.toThrow(BadRequestException);
    });

    it('status = "pending" → ConflictException', async () => {
      prisma.caregiver.findUnique.mockResolvedValue(
        makeCaregiver({ kycStatus: 'pending' }),
      );

      await expect(
        service.resubmitKyc(MOCK_AUTH_USER as any, MOCK_INPUT as any),
      ).rejects.toThrow(ConflictException);
    });

    it('status = "verified" → ConflictException', async () => {
      prisma.caregiver.findUnique.mockResolvedValue(
        makeCaregiver({ kycStatus: 'verified' }),
      );

      await expect(
        service.resubmitKyc(MOCK_AUTH_USER as any, MOCK_INPUT as any),
      ).rejects.toThrow(ConflictException);
    });

    it('ไม่ query documents ถ้า status guard fail', async () => {
      prisma.caregiver.findUnique.mockResolvedValue(
        makeCaregiver({ kycStatus: 'pending' }),
      );

      await expect(
        service.resubmitKyc(MOCK_AUTH_USER as any, MOCK_INPUT as any),
      ).rejects.toThrow(ConflictException);

      expect(prisma.kycDocument.findMany).not.toHaveBeenCalled();
    });
  });

  // ─── Document validation ──────────────────────────────────────────────────

  describe('document validation', () => {
    it('doc ไม่ใช่ของ user → NotFoundException', async () => {
      prisma.caregiver.findUnique.mockResolvedValue(
        makeCaregiver({ kycStatus: 'rejected' }),
      );
      // คืน doc เดียว (ขาดไป 1)
      prisma.kycDocument.findMany.mockResolvedValue([{ id: 'doc-uuid-001' }]);

      await expect(
        service.resubmitKyc(MOCK_AUTH_USER as any, MOCK_INPUT as any),
      ).rejects.toThrow(NotFoundException);
    });

    it('documentIds ว่าง → ข้ามการ validate + link (ไม่ throw)', async () => {
      const inputNoDoc = { ...MOCK_INPUT, documentIds: [] };
      const existing = makeCaregiver({ kycStatus: 'rejected' });
      const updated = makeCaregiver({ kycStatus: 'pending', resubmitCount: 1 });

      prisma.caregiver.findUnique.mockResolvedValue(existing);
      prisma.caregiver.update.mockResolvedValue(updated);

      const result = await service.resubmitKyc(MOCK_AUTH_USER as any, inputNoDoc as any);

      expect(result.kycStatus).toBe('pending');
      expect(prisma.kycDocument.findMany).not.toHaveBeenCalled();
      expect(prisma.kycDocument.updateMany).not.toHaveBeenCalled();
    });
  });

  // ─── Notification failure resilience ─────────────────────────────────────

  describe('notification resilience', () => {
    it('resubmit สำเร็จแม้ notification ล้มเหลว (fire-and-forget)', async () => {
      const existing = makeCaregiver({ kycStatus: 'rejected' });
      const updated = makeCaregiver({ kycStatus: 'pending', resubmitCount: 1 });

      prisma.caregiver.findUnique.mockResolvedValue(existing);
      prisma.kycDocument.findMany.mockResolvedValue(
        MOCK_INPUT.documentIds.map((id) => ({ id })),
      );
      prisma.caregiver.update.mockResolvedValue(updated);
      prisma.kycDocument.updateMany.mockResolvedValue({ count: 2 });

      // notification ล้มเหลว
      notificationService.create.mockRejectedValue(new Error('Notification service down'));

      // ไม่ควร throw
      await expect(
        service.resubmitKyc(MOCK_AUTH_USER as any, MOCK_INPUT as any),
      ).resolves.toBeDefined();
    });
  });
});
