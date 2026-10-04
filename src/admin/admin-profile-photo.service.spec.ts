/**
 * AdminProfilePhotoService — unit tests (PYG-508)
 *
 * Done criteria ของการ์ด:
 *   - approve / reject ได้ทั้งผู้ดูแล kycStatus = pending และ verified (เปลี่ยนรูปหลังผ่าน KYC)
 *   - reject ไม่มีเหตุผล → 400
 *   - kycStatus ไม่เปลี่ยน (ไม่มีการเขียนตาราง caregivers)
 *   - แถว kyc_reviews มี document_id
 */
import { Test, TestingModule } from '@nestjs/testing';
import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { AdminProfilePhotoService } from './admin-profile-photo.service';
import { PrismaService } from '../common/prisma.service';
import { SupabaseService } from '../common/supabase.service';
import { AvatarUrlService } from '../common/avatar-url.service';
import { CaregiverService } from '../identity/kyc/caregiver.service';
import { NotificationService } from '../notification/notification.service';
import { NotificationType } from '../notification/entities/notification-type.enum';
import { AuthUser } from '../common/decorators/current-user.decorator';
import { ROLE_ID } from '../common/constants/roles.constant';
import { PROFILE_PHOTOS_BUCKET } from '../identity/kyc/profile-photo.constants';

const DOC_ID = '11111111-1111-4111-8111-111111111111';
const CAREGIVER_ID = 'caregiver-1';
const USER_ID = 'user-1';
const PENDING_PATH = `${USER_ID}/profile-abc.jpg`;

const admin: AuthUser = {
  id: 'admin-1',
  supabaseUid: 'admin-uid',
  email: 'admin@payung.app',
  role: ROLE_ID.ADMIN,
  isSuspended: false,
};

const tx = {
  kycDocument: { updateMany: jest.fn() },
  user: { update: jest.fn() },
  kycReview: { create: jest.fn() },
  caregiver: { update: jest.fn() },
};

const mockPrisma = {
  kycDocument: {
    findUnique: jest.fn(),
    findFirst: jest.fn(),
    findMany: jest.fn(),
    count: jest.fn(),
  },
  caregiver: { findUnique: jest.fn(), update: jest.fn() },
  kycReview: { findMany: jest.fn() },
  $transaction: jest.fn((fn: (client: typeof tx) => unknown) => fn(tx)),
  $executeRaw: jest.fn().mockResolvedValue(1),
};

const storageBucket = {
  remove: jest.fn(),
  createSignedUrl: jest.fn(),
};
const storageFrom = jest.fn(() => storageBucket);
const mockSupabase = {
  getAdminClient: jest.fn(() => ({ storage: { from: storageFrom } })),
};

const mockAvatarUrl = { resolve: jest.fn() };
const mockCaregiverService = {
  findByUserId: jest.fn(),
  getDocumentsForAdminReview: jest.fn(),
};
const mockNotification = { create: jest.fn().mockResolvedValue(undefined) };

function pendingDoc(overrides: Record<string, unknown> = {}) {
  return {
    id: DOC_ID,
    documentType: 'profile_photo',
    reviewStatus: 'pending',
    fileUrl: PENDING_PATH,
    caregiver: { id: CAREGIVER_ID, userId: USER_ID },
    ...overrides,
  };
}

describe('AdminProfilePhotoService', () => {
  let service: AdminProfilePhotoService;

  beforeEach(async () => {
    jest.clearAllMocks();
    tx.kycDocument.updateMany.mockResolvedValue({ count: 1 });
    storageBucket.remove.mockResolvedValue({ data: [], error: null });

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AdminProfilePhotoService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: SupabaseService, useValue: mockSupabase },
        { provide: AvatarUrlService, useValue: mockAvatarUrl },
        { provide: CaregiverService, useValue: mockCaregiverService },
        { provide: NotificationService, useValue: mockNotification },
      ],
    }).compile();

    service = module.get(AdminProfilePhotoService);
  });

  // ─── approve ──────────────────────────────────────────────────────────────

  describe('approve', () => {
    it('ผู้ดูแลยังไม่มีรูป (KYC pending): ตั้ง avatar_url = path ของรูปนี้ (ไม่ย้ายไฟล์), บันทึก kyc_reviews พร้อม document_id', async () => {
      mockPrisma.kycDocument.findUnique.mockResolvedValue(pendingDoc());

      const result = await service.approve(DOC_ID, admin);

      // ตามการ์ด PYG-508: ไม่คัดลอก / ไม่ลบไฟล์ใน storage
      expect(storageFrom).not.toHaveBeenCalled();

      expect(tx.kycDocument.updateMany).toHaveBeenCalledWith({
        where: { id: DOC_ID, reviewStatus: 'pending' },
        data: { reviewStatus: 'approved', reviewedAt: expect.any(Date) },
      });
      expect(tx.user.update).toHaveBeenCalledWith({
        where: { id: USER_ID },
        data: { avatarUrl: PENDING_PATH },
      });
      expect(tx.kycReview.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          caregiverId: CAREGIVER_ID,
          reviewerId: admin.id,
          action: 'profile_photo_approved',
          documentId: DOC_ID,
        }),
      });
      expect(result).toMatchObject({
        documentId: DOC_ID,
        caregiverId: CAREGIVER_ID,
        reviewStatus: 'approved',
      });
      expect(mockNotification.create).toHaveBeenCalledWith(
        USER_ID,
        NotificationType.profile_photo_approved,
        expect.any(String),
        expect.any(String),
        expect.objectContaining({ documentId: DOC_ID }),
      );
    });

    it('ผู้ดูแล verified เปลี่ยนรูป: avatar_url ชี้ใบใหม่, ไม่ลบไฟล์ใบเดิม และไม่แตะ kycStatus', async () => {
      mockPrisma.kycDocument.findUnique.mockResolvedValue(pendingDoc());

      await service.approve(DOC_ID, admin);

      expect(tx.user.update).toHaveBeenCalledWith({
        where: { id: USER_ID },
        data: { avatarUrl: PENDING_PATH },
      });
      expect(storageBucket.remove).not.toHaveBeenCalled();
      expect(tx.caregiver.update).not.toHaveBeenCalled();
      expect(mockPrisma.caregiver.update).not.toHaveBeenCalled();
    });

    it('เอกสารไม่ใช่รูปโปรไฟล์ → 404', async () => {
      mockPrisma.kycDocument.findUnique.mockResolvedValue(pendingDoc({ documentType: 'id_card_front' }));

      await expect(service.approve(DOC_ID, admin)).rejects.toBeInstanceOf(NotFoundException);
      expect(mockPrisma.$transaction).not.toHaveBeenCalled();
    });

    it('ไม่พบเอกสาร → 404', async () => {
      mockPrisma.kycDocument.findUnique.mockResolvedValue(null);

      await expect(service.approve(DOC_ID, admin)).rejects.toBeInstanceOf(NotFoundException);
    });

    it('ตัดสินไปแล้ว → 409 ไม่เขียน DB', async () => {
      mockPrisma.kycDocument.findUnique.mockResolvedValue(pendingDoc({ reviewStatus: 'approved' }));

      await expect(service.approve(DOC_ID, admin)).rejects.toBeInstanceOf(ConflictException);
      expect(mockPrisma.$transaction).not.toHaveBeenCalled();
    });

    it('แอดมินอีกคนตัดสินตัดหน้า (updateMany ได้ 0) → 409 ไม่ตั้ง avatar_url ไม่แจ้งเตือน', async () => {
      mockPrisma.kycDocument.findUnique.mockResolvedValue(pendingDoc());
      tx.kycDocument.updateMany.mockResolvedValue({ count: 0 });

      await expect(service.approve(DOC_ID, admin)).rejects.toBeInstanceOf(ConflictException);

      expect(tx.user.update).not.toHaveBeenCalled();
      expect(tx.kycReview.create).not.toHaveBeenCalled();
      expect(mockNotification.create).not.toHaveBeenCalled();
    });

    it('แจ้งเตือนล้ม → อนุมัติยังสำเร็จ', async () => {
      mockPrisma.kycDocument.findUnique.mockResolvedValue(pendingDoc());
      mockNotification.create.mockRejectedValueOnce(new Error('enum missing'));

      await expect(service.approve(DOC_ID, admin)).resolves.toMatchObject({
        reviewStatus: 'approved',
      });
    });
  });

  // ─── reject ───────────────────────────────────────────────────────────────

  describe('reject', () => {
    it('บันทึกเหตุผล + document_id, avatar_url ไม่เปลี่ยน, kycStatus ไม่เปลี่ยน', async () => {
      mockPrisma.kycDocument.findUnique.mockResolvedValue(pendingDoc());

      const result = await service.reject(
        { documentId: DOC_ID, reason: '  ใบหน้าไม่ตรงกับบัตร  ' },
        admin,
      );

      expect(tx.kycDocument.updateMany).toHaveBeenCalledWith({
        where: { id: DOC_ID, reviewStatus: 'pending' },
        data: { reviewStatus: 'rejected', reviewedAt: expect.any(Date) },
      });
      expect(tx.kycReview.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          action: 'profile_photo_rejected',
          reason: 'ใบหน้าไม่ตรงกับบัตร',
          documentId: DOC_ID,
          caregiverId: CAREGIVER_ID,
        }),
      });
      expect(tx.user.update).not.toHaveBeenCalled();
      expect(tx.caregiver.update).not.toHaveBeenCalled();
      expect(storageFrom).not.toHaveBeenCalled();
      expect(result.reviewStatus).toBe('rejected');
      expect(mockNotification.create).toHaveBeenCalledWith(
        USER_ID,
        NotificationType.profile_photo_rejected,
        expect.any(String),
        expect.stringContaining('ใบหน้าไม่ตรงกับบัตร'),
        expect.any(Object),
      );
    });

    it.each(['', '   '])('เหตุผลว่าง (%j) → 400 ไม่แตะ DB', async (reason) => {
      await expect(
        service.reject({ documentId: DOC_ID, reason }, admin),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(mockPrisma.kycDocument.findUnique).not.toHaveBeenCalled();
    });

    it('ปฏิเสธซ้ำ → 409', async () => {
      mockPrisma.kycDocument.findUnique.mockResolvedValue(pendingDoc({ reviewStatus: 'rejected' }));

      await expect(
        service.reject({ documentId: DOC_ID, reason: 'ไม่ชัด' }, admin),
      ).rejects.toBeInstanceOf(ConflictException);
    });
  });

  // ─── queue ────────────────────────────────────────────────────────────────

  describe('queue', () => {
    it('อ่านจาก kyc_documents ที่ pending (ไม่กรอง kycStatus) และบอกว่ามีรูปเดิมไหม', async () => {
      mockPrisma.kycDocument.count.mockResolvedValue(2);
      mockPrisma.kycDocument.findMany.mockResolvedValue([
        {
          id: 'doc-a',
          uploadedAt: new Date('2026-10-01'),
          caregiver: {
            id: 'cg-a',
            caregiverNumber: 'CG-1',
            fullName: 'สมหญิง ใจดี',
            kycStatus: 'verified',
            user: { email: 'a@x.com', avatarUrl: 'user-a/avatar-1.jpg' },
          },
        },
        {
          id: 'doc-b',
          uploadedAt: new Date('2026-10-02'),
          caregiver: {
            id: 'cg-b',
            caregiverNumber: null,
            fullName: null,
            kycStatus: 'pending',
            user: { email: 'b@x.com', avatarUrl: null },
          },
        },
      ]);

      const result = await service.queue({ search: ' สม ', page: 1, limit: 20 });

      const where = mockPrisma.kycDocument.findMany.mock.calls[0][0].where;
      expect(where).toMatchObject({
        documentType: 'profile_photo',
        reviewStatus: 'pending',
        caregiver: { is: { fullName: { contains: 'สม', mode: 'insensitive' } } },
      });
      expect(where).not.toHaveProperty('kycStatus');
      expect(result.total).toBe(2);
      expect(result.items).toEqual([
        expect.objectContaining({ documentId: 'doc-a', kycStatus: 'verified', hasApprovedPhoto: true }),
        expect.objectContaining({ documentId: 'doc-b', fullName: '', hasApprovedPhoto: false }),
      ]);
    });
  });

  // ─── reviewDetail ─────────────────────────────────────────────────────────

  describe('reviewDetail', () => {
    beforeEach(() => {
      mockPrisma.caregiver.findUnique.mockResolvedValue({
        userId: USER_ID,
        user: { email: 'cg@x.com', avatarUrl: `${USER_ID}/avatar-old.jpg` },
      });
      mockCaregiverService.findByUserId.mockResolvedValue({
        id: CAREGIVER_ID,
        fullName: 'สมหญิง ใจดี',
        kycStatus: 'verified',
      });
      mockCaregiverService.getDocumentsForAdminReview.mockResolvedValue([
        { id: 'd1', docType: 'id_card_front', signedUrl: 'https://signed/front' },
        { id: 'd2', docType: 'certificate', signedUrl: 'https://signed/cert' },
      ]);
      mockAvatarUrl.resolve.mockResolvedValue('https://signed/old');
      storageBucket.createSignedUrl.mockResolvedValue({
        data: { signedUrl: 'https://signed/pending' },
        error: null,
      });
      mockPrisma.kycReview.findMany.mockResolvedValue([]);
    });

    it('คืนรูป pending + รูปบัตร + รูปเดิม และลง audit ก่อนออก URL ของรูป pending', async () => {
      mockPrisma.kycDocument.findFirst.mockResolvedValue({
        id: DOC_ID,
        fileUrl: PENDING_PATH,
        uploadedAt: new Date(),
        reviewStatus: 'pending',
      });

      const result = await service.reviewDetail(CAREGIVER_ID, admin.id);

      expect(mockPrisma.$executeRaw).toHaveBeenCalled();
      expect(result.pendingPhoto).toMatchObject({
        documentId: DOC_ID,
        signedUrl: 'https://signed/pending',
      });
      expect(result.approvedPhotoUrl).toBe('https://signed/old');
      expect(result.idCardDocuments.map((d) => d.docType)).toEqual(['id_card_front']);
      expect(result.caregiver.email).toBe('cg@x.com');
      expect(mockPrisma.kycReview.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { caregiverId: CAREGIVER_ID, documentId: { not: null } } }),
      );
    });

    it('ไม่มีรูป pending → pendingPhoto = undefined และไม่ลง audit รูป', async () => {
      mockPrisma.kycDocument.findFirst.mockResolvedValue(null);

      const result = await service.reviewDetail(CAREGIVER_ID, admin.id);

      expect(result.pendingPhoto).toBeUndefined();
      expect(mockPrisma.$executeRaw).not.toHaveBeenCalled();
      expect(storageBucket.createSignedUrl).not.toHaveBeenCalled();
    });

    it('ไม่พบผู้ดูแล → 404', async () => {
      mockPrisma.caregiver.findUnique.mockResolvedValue(null);

      await expect(service.reviewDetail(CAREGIVER_ID, admin.id)).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });
  });
});
