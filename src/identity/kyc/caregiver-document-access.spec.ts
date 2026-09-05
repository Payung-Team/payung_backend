/**
 * CaregiverService — สองประตูอ่านเอกสาร KYC (self vs admin)
 *
 * ★ "คนเปิดดูรูปบัตรประชาชนของคนอื่น" คือสิ่งที่ต้องมีร่องรอยที่สุดในระบบนี้
 *   เทสต์ชุดนี้ตรึงว่า:
 *     1. เส้นของ admin ลง admin_audit_logs "ก่อน" ออก signed URL เสมอ
 *     2. ถ้าเขียน audit ไม่สำเร็จ ต้องไม่มี signed URL ออกไปเลย
 *     3. เส้นของเจ้าตัวเองไม่ลง audit (ไม่งั้น log จะท่วมจนหาของจริงไม่เจอ)
 *     4. bucket ถูกตรึงที่ kyc-documents เสมอ ไม่ว่าค่าที่เก็บไว้จะเป็นอะไร
 */
import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { CaregiverService } from './caregiver.service';
import { PrismaService } from '../../common/prisma.service';
import { SupabaseService } from '../../common/supabase.service';
import { KYC_BUCKET, KYC_SIGNED_URL_TTL_SECONDS } from './utils/kyc-storage-path';

const SUPABASE_URL = 'https://evsewucpighcbnhofmug.supabase.co';
const CAREGIVER_ID = 'cg-1';
const CAREGIVER_USER_ID = 'user-cg-1';
const ADMIN_ID = 'user-admin-1';
const OWNER_UID = 'dcc37326-2625-4ba0-bfd9-ff0da2b099b4';

describe('CaregiverService — การเข้าถึงเอกสาร KYC', () => {
  let service: CaregiverService;
  let prisma: {
    kycDocument: { findMany: jest.Mock };
    caregiver: { findUnique: jest.Mock };
    $executeRaw: jest.Mock;
  };
  let createSignedUrl: jest.Mock;
  let from: jest.Mock;

  const docRow = (fileUrl: string) => ({
    id: 'doc-1',
    caregiverId: CAREGIVER_ID,
    userId: CAREGIVER_USER_ID,
    documentType: 'id_card_front',
    fileUrl,
    fileName: 'id.jpg',
    fileSize: 1234,
    mimeType: 'image/jpeg',
    uploadedAt: new Date(),
  });

  beforeEach(async () => {
    createSignedUrl = jest
      .fn()
      .mockResolvedValue({ data: { signedUrl: 'https://signed.example/x' }, error: null });
    from = jest.fn().mockReturnValue({ createSignedUrl });

    prisma = {
      kycDocument: { findMany: jest.fn().mockResolvedValue([docRow(`${OWNER_UID}/id.jpg`)]) },
      caregiver: { findUnique: jest.fn().mockResolvedValue({ userId: CAREGIVER_USER_ID }) },
      $executeRaw: jest.fn().mockResolvedValue(1),
    };

    const mod: TestingModule = await Test.createTestingModule({
      providers: [
        CaregiverService,
        { provide: PrismaService, useValue: prisma },
        { provide: SupabaseService, useValue: { getAdminClient: () => ({ storage: { from } }) } },
        {
          provide: ConfigService,
          useValue: { getOrThrow: jest.fn().mockReturnValue(SUPABASE_URL) },
        },
      ],
    }).compile();

    service = mod.get(CaregiverService);
  });

  describe('getDocumentsForAdminReview', () => {
    it('ลง admin_audit_logs ทุกครั้งที่ออก signed URL ของเอกสารคนอื่น', async () => {
      const docs = await service.getDocumentsForAdminReview(CAREGIVER_ID, ADMIN_ID);

      expect(prisma.$executeRaw).toHaveBeenCalledTimes(1);
      // ตรวจว่า admin id / target / action ถูกส่งเข้า query จริง
      const params = prisma.$executeRaw.mock.calls[0].slice(1);
      expect(params).toContain(ADMIN_ID);
      expect(params).toContain(CAREGIVER_USER_ID);
      const sqlText = (prisma.$executeRaw.mock.calls[0][0] as string[]).join('');
      expect(sqlText).toContain('admin_audit_logs');
      expect(sqlText).toContain('kyc_documents_viewed');

      expect(docs[0].signedUrl).toBe('https://signed.example/x');
    });

    it('เขียน audit ไม่สำเร็จ → throw และไม่ออก signed URL เลย', async () => {
      prisma.$executeRaw.mockRejectedValueOnce(new Error('audit table down'));

      await expect(
        service.getDocumentsForAdminReview(CAREGIVER_ID, ADMIN_ID),
      ).rejects.toThrow('audit table down');

      // ★ ยอมให้แอดมินเปิดดูไม่ได้ชั่วคราว ดีกว่ามีคนดูรูปบัตรแล้วไม่เหลือหลักฐาน
      expect(createSignedUrl).not.toHaveBeenCalled();
    });

    it('audit ถูกเขียนก่อนเรียก storage เสมอ (ลำดับสำคัญ)', async () => {
      const order: string[] = [];
      prisma.$executeRaw.mockImplementation(() => {
        order.push('audit');
        return Promise.resolve(1);
      });
      createSignedUrl.mockImplementation(() => {
        order.push('sign');
        return Promise.resolve({ data: { signedUrl: 'u' }, error: null });
      });

      await service.getDocumentsForAdminReview(CAREGIVER_ID, ADMIN_ID);

      expect(order).toEqual(['audit', 'sign']);
    });
  });

  describe('getOwnDocumentsWithSignedUrls', () => {
    it('เจ้าตัวดูของตัวเอง → ไม่ลง audit (กัน log ท่วมจนหาของจริงไม่เจอ)', async () => {
      const docs = await service.getOwnDocumentsWithSignedUrls(CAREGIVER_ID);

      expect(prisma.$executeRaw).not.toHaveBeenCalled();
      expect(docs[0].signedUrl).toBe('https://signed.example/x');
    });
  });

  describe('bucket ถูกตรึง', () => {
    it('เซ็นด้วย bucket kyc-documents และ TTL 900 วิ เสมอ', async () => {
      await service.getOwnDocumentsWithSignedUrls(CAREGIVER_ID);

      expect(from).toHaveBeenCalledWith(KYC_BUCKET);
      expect(createSignedUrl).toHaveBeenCalledWith(
        `${OWNER_UID}/id.jpg`,
        KYC_SIGNED_URL_TTL_SECONDS,
      );
    });

    it('แถวเก่าที่ยังเป็น URL เต็มของ bucket อื่น → ไม่เซ็นให้ (ไม่ข้าม bucket)', async () => {
      prisma.kycDocument.findMany.mockResolvedValueOnce([
        docRow(`${SUPABASE_URL}/storage/v1/object/public/job-evidence/${OWNER_UID}/p.jpg`),
      ]);

      const docs = await service.getOwnDocumentsWithSignedUrls(CAREGIVER_ID);

      expect(createSignedUrl).not.toHaveBeenCalled();
      expect(docs[0].signedUrl).toBeUndefined();
    });

    it('แถว fixture example.com → ไม่เซ็นให้', async () => {
      prisma.kycDocument.findMany.mockResolvedValueOnce([
        docRow('https://example.com/id-card.jpg'),
      ]);

      const docs = await service.getOwnDocumentsWithSignedUrls(CAREGIVER_ID);

      expect(createSignedUrl).not.toHaveBeenCalled();
      expect(docs[0].signedUrl).toBeUndefined();
    });
  });

  describe('ไม่รั่ว path ดิบออก API', () => {
    it('fileUrl ที่คืนออกไปต้องว่างเสมอ — FE ใช้ signedUrl เท่านั้น', async () => {
      const docs = await service.getOwnDocumentsWithSignedUrls(CAREGIVER_ID);

      expect(docs[0].fileUrl).toBe('');
      expect(JSON.stringify(docs)).not.toContain(OWNER_UID);
    });
  });
});
