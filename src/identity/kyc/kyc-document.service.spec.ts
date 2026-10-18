/**
 * KycDocumentService.create — ใบประกอบวิชาชีพ (PYG-587: AC1, E3–E6, สิทธิ์)
 */
import { Test } from '@nestjs/testing';
import { BadRequestException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { KycDocumentService } from './kyc-document.service';
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

  beforeEach(async () => {
    create = jest.fn().mockImplementation(({ data }) => ({
      id: 'doc-1',
      caregiverId: null,
      uploadedAt: NOW,
      ...data,
    }));
    const mod = await Test.createTestingModule({
      providers: [
        KycDocumentService,
        { provide: PrismaService, useValue: { kycDocument: { create } } },
        { provide: ConfigService, useValue: { getOrThrow: () => SUPABASE_URL } },
        { provide: ClockService, useValue: { now: () => NOW } },
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
});
