/**
 * AdminDrivingLicenseService — อนุมัติ/ปฏิเสธใบขับขี่ (PYG-597: AC4, E3, E5, E7, สิทธิ์)
 */
import 'reflect-metadata';
import { Test } from '@nestjs/testing';
import { ConflictException, NotFoundException } from '@nestjs/common';
import { AdminDrivingLicenseService } from './admin-driving-license.service';
import { AdminDrivingLicenseResolver } from './admin-driving-license.resolver';
import { PrismaService } from '../common/prisma.service';
import { ClockService } from '../common/clock.service';
import { AuthUser } from '../common/decorators/current-user.decorator';
import { ROLES_KEY } from '../common/decorators/roles.decorator';
import { ROLE_ID } from '../common/constants/roles.constant';

const endOfDay = (ymd: string) => new Date(new Date(`${ymd}T00:00:00Z`).getTime() + 17 * 3600 * 1000 - 1);
const NOW = new Date('2026-10-18T03:00:00Z'); // 10:00 ไทย
const DOC_ID = '11111111-1111-4111-8111-111111111111';
const ADMIN = { id: 'admin-1' } as AuthUser;

const pendingDoc = (over: Record<string, unknown> = {}) => ({
  id: DOC_ID,
  documentType: 'driving_license',
  reviewStatus: 'pending',
  expiresAt: endOfDay('2026-12-31'),
  caregiver: { id: 'cg-1' },
  ...over,
});

describe('AdminDrivingLicenseService (PYG-597)', () => {
  let service: AdminDrivingLicenseService;
  let findUnique: jest.Mock;
  let transaction: jest.Mock;
  let tx: { kycDocument: { updateMany: jest.Mock }; kycReview: { create: jest.Mock } };

  beforeEach(async () => {
    tx = {
      kycDocument: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
      kycReview: { create: jest.fn().mockResolvedValue({}) },
    };
    transaction = jest.fn((cb: (t: unknown) => unknown) => cb(tx));
    findUnique = jest.fn().mockResolvedValue(pendingDoc());
    const mod = await Test.createTestingModule({
      providers: [
        AdminDrivingLicenseService,
        { provide: PrismaService, useValue: { kycDocument: { findUnique }, $transaction: transaction } },
        { provide: ClockService, useValue: { now: () => NOW } },
      ],
    }).compile();
    service = mod.get(AdminDrivingLicenseService);
    jest.spyOn(service['logger'], 'log').mockImplementation();
  });

  describe('approve', () => {
    it('อนุมัติ: pending -> approved + kyc_reviews(driving_license_approved, document_id) ใน transaction เดียว', async () => {
      const r = await service.approve(DOC_ID, ADMIN);
      expect(transaction).toHaveBeenCalledTimes(1);
      expect(tx.kycDocument.updateMany).toHaveBeenCalledWith({
        where: { id: DOC_ID, reviewStatus: 'pending' },
        data: { reviewStatus: 'approved', reviewedAt: NOW },
      });
      expect(tx.kycReview.create).toHaveBeenCalledWith({
        data: {
          caregiverId: 'cg-1',
          reviewerId: 'admin-1',
          action: 'driving_license_approved',
          documentId: DOC_ID,
          reviewedAt: NOW,
        },
      });
      expect(r).toMatchObject({ documentId: DOC_ID, caregiverId: 'cg-1', status: 'approved' });
    });

    it('วันหมดอายุเป็นวันนี้ -> อนุมัติได้ (วันหมดอายุเองยังใช้ได้)', async () => {
      findUnique.mockResolvedValue(pendingDoc({ expiresAt: endOfDay('2026-10-18') }));
      await expect(service.approve(DOC_ID, ADMIN)).resolves.toMatchObject({ status: 'approved' });
    });

    it('E5: เลยวันหมดอายุแล้ว -> DRIVING_LICENSE_EXPIRED (422) ไม่เขียนอะไร', async () => {
      findUnique.mockResolvedValue(pendingDoc({ expiresAt: endOfDay('2026-10-17') }));
      await expect(service.approve(DOC_ID, ADMIN)).rejects.toMatchObject({
        extensions: { code: 'DRIVING_LICENSE_EXPIRED', statusCode: 422 },
      });
      expect(transaction).not.toHaveBeenCalled();
    });

    it('ไม่มีวันหมดอายุ -> DRIVING_LICENSE_EXPIRED (ไม่อนุมัติใบที่ไม่มีวันหมดอายุ)', async () => {
      findUnique.mockResolvedValue(pendingDoc({ expiresAt: null }));
      await expect(service.approve(DOC_ID, ADMIN)).rejects.toMatchObject({
        extensions: { code: 'DRIVING_LICENSE_EXPIRED' },
      });
    });

    it('แอดมินสองคนกดพร้อมกัน: claim ได้ 0 แถว -> 409', async () => {
      tx.kycDocument.updateMany.mockResolvedValue({ count: 0 });
      await expect(service.approve(DOC_ID, ADMIN)).rejects.toBeInstanceOf(ConflictException);
    });

    it('ไม่ใช่ pending (approved/rejected) -> 409 · ไม่ใช่ใบขับขี่/ไม่พบ/ยังไม่ผูกผู้ดูแล -> 404', async () => {
      findUnique.mockResolvedValue(pendingDoc({ reviewStatus: 'approved' }));
      await expect(service.approve(DOC_ID, ADMIN)).rejects.toBeInstanceOf(ConflictException);
      findUnique.mockResolvedValue(pendingDoc({ documentType: 'professional_license' }));
      await expect(service.approve(DOC_ID, ADMIN)).rejects.toBeInstanceOf(NotFoundException);
      findUnique.mockResolvedValue(null);
      await expect(service.approve(DOC_ID, ADMIN)).rejects.toBeInstanceOf(NotFoundException);
      findUnique.mockResolvedValue(pendingDoc({ caregiver: null }));
      await expect(service.approve(DOC_ID, ADMIN)).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('reject', () => {
    it('ปฏิเสธ: pending -> rejected + kyc_reviews(driving_license_rejected, reason trim, document_id) ใน transaction เดียว', async () => {
      const r = await service.reject({ documentId: DOC_ID, reason: '  วันหมดอายุไม่ตรงกับรูป  ' }, ADMIN);
      expect(transaction).toHaveBeenCalledTimes(1);
      expect(tx.kycDocument.updateMany).toHaveBeenCalledWith({
        where: { id: DOC_ID, reviewStatus: 'pending' },
        data: { reviewStatus: 'rejected', reviewedAt: NOW },
      });
      expect(tx.kycReview.create).toHaveBeenCalledWith({
        data: {
          caregiverId: 'cg-1',
          reviewerId: 'admin-1',
          action: 'driving_license_rejected',
          reason: 'วันหมดอายุไม่ตรงกับรูป',
          documentId: DOC_ID,
          reviewedAt: NOW,
        },
      });
      expect(r.status).toBe('rejected');
    });

    it.each([[undefined], [''], ['   '], ['\n\t']])(
      'ไม่มีเหตุผล/มีแต่ช่องว่าง (%j) -> REJECT_REASON_REQUIRED (422) ไม่เขียนอะไร',
      async (reason) => {
        await expect(service.reject({ documentId: DOC_ID, reason }, ADMIN)).rejects.toMatchObject({
          extensions: { code: 'REJECT_REASON_REQUIRED', statusCode: 422 },
        });
        expect(transaction).not.toHaveBeenCalled();
      },
    );

    it('ปฏิเสธใบที่หมดอายุแล้วได้ (ไม่ต้องตรวจวันหมดอายุ)', async () => {
      findUnique.mockResolvedValue(pendingDoc({ expiresAt: endOfDay('2026-01-01') }));
      await expect(service.reject({ documentId: DOC_ID, reason: 'x' }, ADMIN)).resolves.toMatchObject({
        status: 'rejected',
      });
    });

    it('E7: บันทึกด้วย create แถวใหม่ทุกครั้ง — ประวัติรอบก่อนไม่ถูกลบ/ทับ', async () => {
      await service.reject({ documentId: DOC_ID, reason: 'รอบแรก' }, ADMIN);
      expect(tx.kycReview.create).toHaveBeenCalledTimes(1);
      expect((tx.kycReview as Record<string, unknown>)['deleteMany']).toBeUndefined();
      expect((tx.kycReview as Record<string, unknown>)['update']).toBeUndefined();
    });

    it('ใบที่ถูกตัดสินไปแล้ว -> 409', async () => {
      findUnique.mockResolvedValue(pendingDoc({ reviewStatus: 'rejected' }));
      await expect(service.reject({ documentId: DOC_ID, reason: 'x' }, ADMIN)).rejects.toBeInstanceOf(
        ConflictException,
      );
    });
  });

  it('สิทธิ์: เฉพาะ role แอดมิน/ซูเปอร์แอดมินเรียก resolver ได้ (ไม่รวมผู้ดูแล)', () => {
    const roles = Reflect.getMetadata(ROLES_KEY, AdminDrivingLicenseResolver);
    expect(roles).toEqual([ROLE_ID.ADMIN, ROLE_ID.SUPER_ADMIN]);
    expect(roles).not.toContain(ROLE_ID.CAREGIVER);
  });
});
