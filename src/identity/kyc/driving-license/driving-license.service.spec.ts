/**
 * DrivingLicenseService (PYG-597: AC1–AC3, AC5, E5, E10, สิทธิ์)
 */
import { Test } from '@nestjs/testing';
import { DrivingLicenseService } from './driving-license.service';
import { PrismaService } from '../../../common/prisma.service';
import { ClockService } from '../../../common/clock.service';

const endOfDay = (ymd: string) => new Date(new Date(`${ymd}T00:00:00Z`).getTime() + 17 * 3600 * 1000 - 1);
let NOW = new Date('2026-10-18T03:00:00Z'); // 10:00 ไทย

describe('DrivingLicenseService', () => {
  let service: DrivingLicenseService;
  let findMany: jest.Mock;

  beforeEach(async () => {
    NOW = new Date('2026-10-18T03:00:00Z');
    findMany = jest.fn().mockResolvedValue([]);
    const mod = await Test.createTestingModule({
      providers: [
        DrivingLicenseService,
        { provide: PrismaService, useValue: { kycDocument: { findMany } } },
        { provide: ClockService, useValue: { now: () => NOW } },
      ],
    }).compile();
    service = mod.get(DrivingLicenseService);
  });

  describe('validateExpiry (AC3, E5)', () => {
    it('ไม่ส่งวันหมดอายุ -> DRIVING_LICENSE_EXPIRY_REQUIRED (422)', () => {
      for (const v of [undefined, null, new Date('invalid')]) {
        expect(() => service.validateExpiry(v as never)).toThrow(
          expect.objectContaining({ extensions: expect.objectContaining({ code: 'DRIVING_LICENSE_EXPIRY_REQUIRED', statusCode: 422 }) }),
        );
      }
    });

    it('E5: วันหมดอายุผ่านมาแล้ว (เมื่อวานตามเวลาไทย) -> DRIVING_LICENSE_EXPIRED (422)', () => {
      expect(() => service.validateExpiry(new Date('2026-10-17T00:00:00Z'))).toThrow(
        expect.objectContaining({ extensions: expect.objectContaining({ code: 'DRIVING_LICENSE_EXPIRED', statusCode: 422 }) }),
      );
    });

    it('วันหมดอายุตรงกับวันนี้ (เวลาไทย) -> DRIVING_LICENSE_EXPIRED ตอนอัปโหลด (ตรงกับ FE ที่ปิดวันนี้)', () => {
      expect(() => service.validateExpiry(new Date('2026-10-18T00:00:00Z'))).toThrow(
        expect.objectContaining({ extensions: expect.objectContaining({ code: 'DRIVING_LICENSE_EXPIRED', statusCode: 422 }) }),
      );
    });

    it('พรุ่งนี้ (เวลาไทย) -> รับ และเก็บเป็นสิ้นวัน', () => {
      expect(service.validateExpiry(new Date('2026-10-19T00:00:00Z'))).toEqual(endOfDay('2026-10-19'));
    });

    it('เทียบด้วยเวลา server + ปฏิทินไทย: 00:30 ไทยของวันที่ 19 (17:30Z) วันหมดอายุ 18 -> EXPIRED', () => {
      NOW = new Date('2026-10-18T17:30:00Z');
      expect(() => service.validateExpiry(new Date('2026-10-18T00:00:00Z'))).toThrow(
        expect.objectContaining({ extensions: expect.objectContaining({ code: 'DRIVING_LICENSE_EXPIRED' }) }),
      );
    });

    it('วันในอนาคต -> สิ้นวันเวลาไทย', () => {
      expect(service.validateExpiry(new Date('2027-05-01T00:00:00Z')).toISOString()).toBe('2027-05-01T16:59:59.999Z');
    });
  });

  describe('assertForKyc (AC1, AC2, E7, E10)', () => {
    const doc = (over: Record<string, unknown> = {}) => ({
      id: 'd1',
      reviewStatus: 'pending',
      expiresAt: endOfDay('2026-12-31'),
      uploadedAt: new Date('2026-10-01'),
      ...over,
    });

    it('AC1: ขับเองแต่ไม่ส่งเอกสารเลย -> DRIVING_LICENSE_REQUIRED (422)', async () => {
      await expect(service.assertForKyc('u1', true, [])).rejects.toMatchObject({
        extensions: { code: 'DRIVING_LICENSE_REQUIRED', statusCode: 422 },
      });
      expect(findMany).not.toHaveBeenCalled();
    });

    it('AC1: ขับเอง ส่งเอกสารอื่นแต่ไม่มีใบขับขี่ -> DRIVING_LICENSE_REQUIRED', async () => {
      findMany.mockResolvedValue([]);
      await expect(service.assertForKyc('u1', true, ['x'])).rejects.toMatchObject({
        extensions: { code: 'DRIVING_LICENSE_REQUIRED' },
      });
    });

    it('AC3: ขับเอง มีใบแต่ไม่มีวันหมดอายุ -> DRIVING_LICENSE_EXPIRY_REQUIRED', async () => {
      findMany.mockResolvedValue([doc({ expiresAt: null })]);
      await expect(service.assertForKyc('u1', true, ['d1'])).rejects.toMatchObject({
        extensions: { code: 'DRIVING_LICENSE_EXPIRY_REQUIRED' },
      });
    });

    it('ขับเอง ใบหมดอายุแล้วตอนส่ง -> DRIVING_LICENSE_EXPIRED', async () => {
      findMany.mockResolvedValue([doc({ expiresAt: endOfDay('2026-10-17') })]);
      await expect(service.assertForKyc('u1', true, ['d1'])).rejects.toMatchObject({
        extensions: { code: 'DRIVING_LICENSE_EXPIRED' },
      });
    });

    it('ขับเอง ใบหมดอายุวันนี้ -> ผ่าน', async () => {
      findMany.mockResolvedValue([doc({ expiresAt: endOfDay('2026-10-18') })]);
      await expect(service.assertForKyc('u1', true, ['d1'])).resolves.toBeUndefined();
    });

    it('E7: ใบที่ถูกปฏิเสธส่งซ้ำไม่ได้ -> REQUIRED (ต้องอัปโหลดใบใหม่)', async () => {
      findMany.mockResolvedValue([doc({ reviewStatus: 'rejected' })]);
      await expect(service.assertForKyc('u1', true, ['d1'])).rejects.toMatchObject({
        extensions: { code: 'DRIVING_LICENSE_REQUIRED' },
      });
    });

    it('ขับเอง มีใบที่ใช้ได้ -> ผ่าน (รอตรวจก็ส่ง KYC ได้)', async () => {
      findMany.mockResolvedValue([doc()]);
      await expect(service.assertForKyc('u1', true, ['d1'])).resolves.toBeUndefined();
    });

    it.each([[false], [undefined]])('AC2/E10: selfDriveTransport = %s -> ไม่ตรวจใบขับขี่ ไม่ query', async (v) => {
      await expect(service.assertForKyc('u1', v, [])).resolves.toBeUndefined();
      expect(findMany).not.toHaveBeenCalled();
    });

    it('สิทธิ์: ตรวจเฉพาะเอกสารของผู้ใช้ที่ล็อกอิน (userId จาก session)', async () => {
      findMany.mockResolvedValue([doc()]);
      await service.assertForKyc('u1', true, ['d1', 'd2']);
      expect(findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: { in: ['d1', 'd2'] }, userId: 'u1', documentType: 'driving_license' },
        }),
      );
    });
  });

  describe('assertVerified / isVerified (AC5)', () => {
    const owner = { caregiverId: 'cg-1', userId: 'u1' };
    const rows = (over: Record<string, unknown> = {}) => [
      { id: 'd1', reviewStatus: 'approved', expiresAt: endOfDay('2026-12-31'), uploadedAt: new Date('2026-09-01'), ...over },
    ];

    it('ผ่าน: ไม่ throw', async () => {
      findMany.mockResolvedValue(rows());
      await expect(service.assertVerified(owner)).resolves.toBeUndefined();
      expect(await service.isVerified({ ...owner, transportMode: null })).toBe(true);
    });

    it.each([
      ['ไม่มีใบ', []],
      ['รอตรวจ', rows({ reviewStatus: 'pending' })],
      ['ถูกปฏิเสธ', rows({ reviewStatus: 'rejected' })],
      ['หมดอายุ', rows({ expiresAt: endOfDay('2026-10-17') })],
    ])('%s -> DRIVING_LICENSE_NOT_VERIFIED (422)', async (_n, data) => {
      findMany.mockResolvedValue(data);
      await expect(service.assertVerified(owner)).rejects.toMatchObject({
        extensions: { code: 'DRIVING_LICENSE_NOT_VERIFIED', statusCode: 422 },
      });
      expect(await service.isVerified({ ...owner, transportMode: null })).toBe(false);
    });

    it('E3: ใบอนุมัติแล้วข้ามวันหมดอายุ -> false โดยไม่แก้ข้อมูล (เรียกซ้ำด้วยเวลาใหม่)', async () => {
      findMany.mockResolvedValue(rows({ expiresAt: endOfDay('2026-10-18') }));
      expect(await service.isVerified({ ...owner, transportMode: null })).toBe(true);
      NOW = new Date('2026-10-18T17:00:00Z'); // 00:00 ไทยวันที่ 19
      expect(await service.isVerified({ ...owner, transportMode: null })).toBe(false);
    });

    it('จับคู่ใบที่ผูกกับผู้ดูแล + ใบที่ไม่ผูกแต่ตรวจแล้ว (ถูกปลดตอนยื่นซ้ำ) · ไม่นับใบไม่ผูกที่ยังรอตรวจ (PYG-671)', async () => {
      findMany.mockResolvedValue([]);
      await service.getState(owner);
      expect(findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            documentType: 'driving_license',
            OR: [
              { caregiverId: 'cg-1' },
              {
                userId: 'u1',
                caregiverId: null,
                reviewStatus: { in: ['approved', 'rejected'] },
              },
            ],
          },
        }),
      );
    });
  });
});
