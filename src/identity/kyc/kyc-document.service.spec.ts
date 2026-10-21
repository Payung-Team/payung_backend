/**
 * KycDocumentService.create — ใบประกอบวิชาชีพ (PYG-587: AC1, E3–E6, สิทธิ์)
 */
import { Test } from '@nestjs/testing';
import { BadRequestException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { KycDocumentService } from './kyc-document.service';
import { DrivingLicenseService } from './driving-license/driving-license.service';
import { PrismaService } from '../../common/prisma.service';
import { ClockService } from '../../common/clock.service';

const SUPABASE_URL = 'https://proj.supabase.co';
const OWNER_UID = '11111111-1111-4111-8111-111111111111';
const OTHER_UID = '22222222-2222-4222-8222-222222222222';
const NOW = new Date('2026-10-18T03:00:00Z'); // 10:00 ไทย

function base(over: Record<string, unknown> = {}) {
  return {
    userId: 'user-1',
    ownerUid: OWNER_UID,
    documentType: 'professional_license',
    fileUrl: `${OWNER_UID}/license.pdf`,
    fileName: 'license.pdf',
    fileSize: 1000,
    mimeType: 'application/pdf',
    licenseNumber: ' N-12345 ',
    expiresAt: new Date('2027-12-31T00:00:00Z'),
    ...over,
  };
}

describe('KycDocumentService.create — professional_license (PYG-587)', () => {
  let service: KycDocumentService;
  let create: jest.Mock;
  let caregiverFindUnique: jest.Mock;

  beforeEach(async () => {
    caregiverFindUnique = jest.fn().mockResolvedValue({ id: 'cg-1' });
    create = jest.fn().mockImplementation(({ data }) => ({
      id: 'doc-1',
      caregiverId: null,
      uploadedAt: NOW,
      ...data,
    }));
    const mod = await Test.createTestingModule({
      providers: [
        KycDocumentService,
        { provide: PrismaService, useValue: { kycDocument: { create }, caregiver: { findUnique: caregiverFindUnique } } },
        { provide: ConfigService, useValue: { getOrThrow: () => SUPABASE_URL } },
        { provide: ClockService, useValue: { now: () => NOW } },
        DrivingLicenseService,
      ],
    }).compile();
    service = mod.get(KycDocumentService);
  });

  it('AC1: บันทึกเลข (ตัดช่องว่าง) + สิ้นวันหมดอายุเวลาไทย + review_status = pending', async () => {
    const doc = await service.create(base());
    const data = create.mock.calls[0][0].data;
    expect(data.licenseNumber).toBe('N-12345');
    expect(data.expiresAt.toISOString()).toBe('2027-12-31T16:59:59.999Z');
    expect(data.reviewStatus).toBe('pending');
    expect(doc.licenseNumber).toBe('N-12345');
    expect(doc.reviewStatus).toBe('pending');
  });

  it('E6: อัปโหลดใบใหม่ = สร้างแถวใหม่ pending เสมอ (ไม่ update/ลบแถวเดิม)', async () => {
    await service.create(base());
    await service.create(base({ licenseNumber: 'N-999' }));
    expect(create).toHaveBeenCalledTimes(2);
  });

  it.each([
    ['ไม่มีเลข', { licenseNumber: undefined }, 'LICENSE_NUMBER_REQUIRED'],
    ['เลขมีแต่ช่องว่าง', { licenseNumber: '   ' }, 'LICENSE_NUMBER_REQUIRED'],
    ['ไม่มีวันหมดอายุ', { expiresAt: undefined }, 'LICENSE_EXPIRY_REQUIRED'],
    ['E3 วันนี้', { expiresAt: new Date('2026-10-18T00:00:00Z') }, 'LICENSE_EXPIRY_NOT_FUTURE'],
    ['E4 ย้อนหลัง', { expiresAt: new Date('2025-01-01T00:00:00Z') }, 'LICENSE_EXPIRY_NOT_FUTURE'],
  ])('ปฏิเสธ 422 + code: %s', async (_name, over, code) => {
    await expect(service.create(base(over))).rejects.toMatchObject({
      extensions: { code, statusCode: 422 },
    });
    expect(create).not.toHaveBeenCalled();
  });

  it('เอกสารชนิดอื่น: ไม่ตรวจ/ไม่เก็บเลขและวันหมดอายุ ไม่ตั้ง review_status', async () => {
    await service.create(
      base({ documentType: 'certificate', licenseNumber: undefined, expiresAt: undefined }),
    );
    const data = create.mock.calls[0][0].data;
    expect(data.licenseNumber).toBeUndefined();
    expect(data.expiresAt).toBeUndefined();
    expect(data.reviewStatus).toBeUndefined();
  });

  it('สิทธิ์: path ของโฟลเดอร์คนอื่นถูกปฏิเสธ (ตรวจจาก ownerUid ของ session ไม่ใช่ input)', async () => {
    await expect(
      service.create(base({ fileUrl: `${OTHER_UID}/license.pdf` })),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(create).not.toHaveBeenCalled();
  });

  // PYG-669: ผู้ดูแลที่ verified แล้วส่ง KYC ซ้ำไม่ได้ → ใบต่ออายุต้องผูกตอนอัปโหลด ไม่งั้นแอดมินไม่เห็น
  it('PYG-669: ผู้ดูแลที่ KYC อนุมัติแล้ว → ผูก caregiverId ตอนอัปโหลด (ค้นจาก userId ของ session)', async () => {
    caregiverFindUnique.mockResolvedValue({
      id: 'cg-1',
      kycStatus: 'verified',
    });
    await service.create(base());
    expect(caregiverFindUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { userId: 'user-1' } }),
    );
    expect(create.mock.calls[0][0].data.caregiverId).toBe('cg-1');
  });

  it.each(['pending', 'rejected', 'none'])(
    'PYG-669: ผู้ดูแลที่ KYC เป็น %s → ไม่ผูก (ผูกตอน submit/resubmit ตาม documentIds เหมือนเดิม)',
    async (kycStatus) => {
      caregiverFindUnique.mockResolvedValue({ id: 'cg-1', kycStatus });
      await service.create(base());
      expect(create.mock.calls[0][0].data.caregiverId).toBeUndefined();
    },
  );

  it('PYG-669: ผู้สมัครใหม่ที่ยังไม่มีแถวผู้ดูแล → ไม่ผูก', async () => {
    caregiverFindUnique.mockResolvedValue(null);
    await service.create(base());
    expect(create.mock.calls[0][0].data.caregiverId).toBeUndefined();
  });
});

describe('KycDocumentService.create - driving_license (PYG-597)', () => {
  let service: KycDocumentService;
  let create: jest.Mock;
  let caregiverFindUnique: jest.Mock;

  const driving = (over: Record<string, unknown> = {}) =>
    base({
      documentType: 'driving_license',
      fileUrl: `${OWNER_UID}/driving.jpg`,
      fileName: 'driving.jpg',
      mimeType: 'image/jpeg',
      licenseNumber: undefined,
      expiresAt: new Date('2027-06-30T00:00:00Z'),
      ...over,
    });

  beforeEach(async () => {
    caregiverFindUnique = jest.fn().mockResolvedValue({ id: 'cg-1' });
    create = jest.fn().mockImplementation(({ data }) => ({ id: 'doc-9', caregiverId: null, uploadedAt: NOW, ...data }));
    const mod = await Test.createTestingModule({
      providers: [
        KycDocumentService,
        { provide: PrismaService, useValue: { kycDocument: { create }, caregiver: { findUnique: caregiverFindUnique } } },
        { provide: ConfigService, useValue: { getOrThrow: () => SUPABASE_URL } },
        { provide: ClockService, useValue: { now: () => NOW } },
        DrivingLicenseService,
      ],
    }).compile();
    service = mod.get(KycDocumentService);
  });

  it('AC3: เก็บวันหมดอายุเป็นสิ้นวันเวลาไทย + review_status = pending (E7: ใบใหม่เข้าคิวตรวจ)', async () => {
    const doc = await service.create(driving());
    const data = create.mock.calls[0][0].data;
    expect(data.documentType).toBe('driving_license');
    expect(data.expiresAt.toISOString()).toBe('2027-06-30T16:59:59.999Z');
    expect(data.reviewStatus).toBe('pending');
    expect(doc.reviewStatus).toBe('pending');
    expect(doc.expiresAt?.toISOString()).toBe('2027-06-30T16:59:59.999Z');
  });

  it('ไม่เก็บเลขใบขับขี่ (ยังไม่เคาะ) แม้ client ส่งมา', async () => {
    await service.create(driving({ licenseNumber: '12345678' }));
    expect(create.mock.calls[0][0].data.licenseNumber).toBeUndefined();
  });

  it('ผูกกับผู้ดูแลทันทีถ้ามีแถวผู้ดูแล (ค้นจาก userId ของ session) เพื่อให้แอดมินเห็นในหน้า review', async () => {
    await service.create(driving());
    expect(caregiverFindUnique).toHaveBeenCalledWith({ where: { userId: 'user-1' }, select: { id: true } });
    expect(create.mock.calls[0][0].data.caregiverId).toBe('cg-1');
  });

  it('ผู้ดูแลใหม่ที่ยังไม่มีแถว -> caregiverId ไม่ถูกตั้ง (link ตอน submit KYC)', async () => {
    caregiverFindUnique.mockResolvedValue(null);
    await service.create(driving());
    expect(create.mock.calls[0][0].data.caregiverId).toBeUndefined();
  });

  it.each([
    ['ไม่ส่งวันหมดอายุ', { expiresAt: undefined }, 'DRIVING_LICENSE_EXPIRY_REQUIRED'],
    ['E5 วันหมดอายุผ่านมาแล้ว', { expiresAt: new Date('2026-10-17T00:00:00Z') }, 'DRIVING_LICENSE_EXPIRED'],
  ])('422 + code: %s', async (_n, over, code) => {
    await expect(service.create(driving(over))).rejects.toMatchObject({ extensions: { code, statusCode: 422 } });
    expect(create).not.toHaveBeenCalled();
  });

  it('วันหมดอายุตรงกับวันนี้ (เวลาไทย) -> DRIVING_LICENSE_EXPIRED (ตรงกับ FE ที่ปิดวันนี้) ไม่สร้างแถว', async () => {
    await expect(service.create(driving({ expiresAt: new Date('2026-10-18T00:00:00Z') }))).rejects.toMatchObject({
      extensions: { code: 'DRIVING_LICENSE_EXPIRED', statusCode: 422 },
    });
    expect(create).not.toHaveBeenCalled();
  });

  it('พรุ่งนี้ (เวลาไทย) -> รับ และเก็บเป็นสิ้นวัน', async () => {
    await expect(service.create(driving({ expiresAt: new Date('2026-10-19T00:00:00Z') }))).resolves.toBeDefined();
    expect(create.mock.calls[0][0].data.expiresAt.toISOString()).toBe('2026-10-19T16:59:59.999Z');
  });

  it('สิทธิ์: path ของโฟลเดอร์คนอื่นถูกปฏิเสธ', async () => {
    await expect(service.create(driving({ fileUrl: `${OTHER_UID}/driving.jpg` }))).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(create).not.toHaveBeenCalled();
  });
});
