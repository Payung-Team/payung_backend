/**
 * AdminLicenseService — อนุมัติ/ปฏิเสธใบประกอบวิชาชีพ (PYG-587: AC5, E6, E7, สิทธิ์, แจ้งเตือน)
 */
import 'reflect-metadata';
import { Test } from '@nestjs/testing';
import { ConflictException, NotFoundException } from '@nestjs/common';
import { AdminLicenseService } from './admin-license.service';
import { AdminLicenseResolver } from './admin-license.resolver';
import { PrismaService } from '../common/prisma.service';
import { ClockService } from '../common/clock.service';
import { NotificationService } from '../notification/notification.service';
import { AuthUser } from '../common/decorators/current-user.decorator';
import { ROLES_KEY } from '../common/decorators/roles.decorator';
import { ROLE_ID } from '../common/constants/roles.constant';

const NOW = new Date('2026-10-18T03:00:00Z');
const DOC_ID = '11111111-1111-4111-8111-111111111111';
const ADMIN = { id: 'admin-1' } as AuthUser;

function pendingDoc(over: Record<string, unknown> = {}) {
  return {
    id: DOC_ID,
    documentType: 'professional_license',
    reviewStatus: 'pending',
    expiresAt: new Date('2027-12-31T16:59:59.999Z'),
    caregiver: { id: 'cg-1', userId: 'user-9' },
    ...over,
  };
}

describe('AdminLicenseService (PYG-587)', () => {
  let service: AdminLicenseService;
  let findUnique: jest.Mock;
  let tx: { kycDocument: { updateMany: jest.Mock }; kycReview: { create: jest.Mock } };
  let transaction: jest.Mock;
  let notifCreate: jest.Mock;

  beforeEach(async () => {
    tx = {
      kycDocument: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
      kycReview: { create: jest.fn().mockResolvedValue({}) },
    };
    transaction = jest.fn((cb: (t: unknown) => unknown) => cb(tx));
    findUnique = jest.fn().mockResolvedValue(pendingDoc());
    notifCreate = jest.fn().mockResolvedValue({});

    const mod = await Test.createTestingModule({
      providers: [
        AdminLicenseService,
        { provide: PrismaService, useValue: { kycDocument: { findUnique }, $transaction: transaction } },
        { provide: NotificationService, useValue: { create: notifCreate } },
        { provide: ClockService, useValue: { now: () => NOW } },
      ],
    }).compile();
    service = mod.get(AdminLicenseService);
    jest.spyOn(service['logger'], 'error').mockImplementation();
    jest.spyOn(service['logger'], 'log').mockImplementation();
  });

  describe('approve', () => {
    it('อนุมัติ: pending → approved + kyc_reviews(license_approved, document_id) ใน transaction เดียว', async () => {
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
          action: 'license_approved',
          documentId: DOC_ID,
          reviewedAt: NOW,
        },
      });
      expect(r).toMatchObject({ documentId: DOC_ID, caregiverId: 'cg-1', status: 'approved' });
    });

    it('แจ้งเตือนผู้ดูแล (license_approved) ไปที่เจ้าของใบ', async () => {
      await service.approve(DOC_ID, ADMIN);
      expect(notifCreate).toHaveBeenCalledWith(
        'user-9',
        'license_approved',
        expect.any(String),
        expect.any(String),
        expect.objectContaining({ documentId: DOC_ID }),
      );
    });

    it('E7: วันหมดอายุผ่านไปแล้ว → LICENSE_EXPIRED (422) ไม่เขียนอะไร', async () => {
      findUnique.mockResolvedValue(pendingDoc({ expiresAt: new Date('2026-10-18T02:59:59.999Z') }));
      await expect(service.approve(DOC_ID, ADMIN)).rejects.toMatchObject({
        extensions: { code: 'LICENSE_EXPIRED', statusCode: 422 },
      });
      expect(transaction).not.toHaveBeenCalled();
      expect(notifCreate).not.toHaveBeenCalled();
    });

    it('แอดมินสองคนกดพร้อมกัน: claim ได้ 0 แถว → 409 และไม่แจ้งเตือน', async () => {
      tx.kycDocument.updateMany.mockResolvedValue({ count: 0 });
      await expect(service.approve(DOC_ID, ADMIN)).rejects.toBeInstanceOf(ConflictException);
      expect(notifCreate).not.toHaveBeenCalled();
    });

    it('ใบที่ไม่ใช่ pending (approved/rejected/expired) → 409', async () => {
      findUnique.mockResolvedValue(pendingDoc({ reviewStatus: 'expired' }));
      await expect(service.approve(DOC_ID, ADMIN)).rejects.toBeInstanceOf(ConflictException);
    });

    it('เอกสารไม่ใช่ใบประกอบฯ / ไม่พบ / ยังไม่ผูกผู้ดูแล → 404', async () => {
      findUnique.mockResolvedValue(pendingDoc({ documentType: 'certificate' }));
      await expect(service.approve(DOC_ID, ADMIN)).rejects.toBeInstanceOf(NotFoundException);
      findUnique.mockResolvedValue(null);
      await expect(service.approve(DOC_ID, ADMIN)).rejects.toBeInstanceOf(NotFoundException);
      findUnique.mockResolvedValue(pendingDoc({ caregiver: null }));
      await expect(service.approve(DOC_ID, ADMIN)).rejects.toBeInstanceOf(NotFoundException);
    });

    it('แจ้งเตือนล้ม → การอนุมัติยังสำเร็จ และมี log', async () => {
      notifCreate.mockRejectedValue(new Error('enum value license_approved does not exist'));
      await expect(service.approve(DOC_ID, ADMIN)).resolves.toMatchObject({ status: 'approved' });
      expect(service['logger'].error).toHaveBeenCalledWith(
        expect.objectContaining({ event: 'license.notify_failed', type: 'license_approved' }),
      );
    });
  });

  describe('reject', () => {
    it('ปฏิเสธ: pending → rejected + kyc_reviews(license_rejected, reason, document_id) ใน transaction เดียว', async () => {
      const r = await service.reject({ documentId: DOC_ID, reason: '  รูปไม่ชัด  ' }, ADMIN);

      expect(transaction).toHaveBeenCalledTimes(1);
      expect(tx.kycDocument.updateMany).toHaveBeenCalledWith({
        where: { id: DOC_ID, reviewStatus: 'pending' },
        data: { reviewStatus: 'rejected', reviewedAt: NOW },
      });
      expect(tx.kycReview.create).toHaveBeenCalledWith({
        data: {
          caregiverId: 'cg-1',
          reviewerId: 'admin-1',
          action: 'license_rejected',
          reason: 'รูปไม่ชัด',
          documentId: DOC_ID,
          reviewedAt: NOW,
        },
      });
      expect(r.status).toBe('rejected');
    });

    it('E6: บันทึกด้วย create แถวใหม่ — ไม่ลบ/ไม่แก้ประวัติเดิม', async () => {
      await service.reject({ documentId: DOC_ID, reason: 'x' }, ADMIN);
      expect(tx.kycReview.create).toHaveBeenCalledTimes(1);
      expect((tx as any).kycReview.deleteMany).toBeUndefined();
    });

    it.each([[undefined], [''], ['   '], ['\n\t ']])(
      'ไม่มีเหตุผล/มีแต่ช่องว่าง (%j) → LICENSE_REJECT_REASON_REQUIRED (422) ไม่เขียนอะไร',
      async (reason) => {
        await expect(service.reject({ documentId: DOC_ID, reason }, ADMIN)).rejects.toMatchObject({
          extensions: { code: 'LICENSE_REJECT_REASON_REQUIRED', statusCode: 422 },
        });
        expect(transaction).not.toHaveBeenCalled();
        expect(notifCreate).not.toHaveBeenCalled();
      },
    );

    it('แจ้งเตือนผู้ดูแล (license_rejected) พร้อมเหตุผล', async () => {
      await service.reject({ documentId: DOC_ID, reason: 'เลขไม่ตรง' }, ADMIN);
      expect(notifCreate).toHaveBeenCalledWith(
        'user-9',
        'license_rejected',
        expect.any(String),
        expect.stringContaining('เลขไม่ตรง'),
        expect.objectContaining({ reason: 'เลขไม่ตรง' }),
      );
    });

    it('แจ้งเตือนล้ม → การปฏิเสธยังสำเร็จ และมี log', async () => {
      notifCreate.mockRejectedValue(new Error('boom'));
      await expect(
        service.reject({ documentId: DOC_ID, reason: 'x' }, ADMIN),
      ).resolves.toMatchObject({ status: 'rejected' });
      expect(service['logger'].error).toHaveBeenCalled();
    });

    it('ใบที่ถูกตัดสินไปแล้ว → 409', async () => {
      findUnique.mockResolvedValue(pendingDoc({ reviewStatus: 'approved' }));
      await expect(
        service.reject({ documentId: DOC_ID, reason: 'x' }, ADMIN),
      ).rejects.toBeInstanceOf(ConflictException);
    });
  });

  describe('สิทธิ์', () => {
    it('เฉพาะ role แอดมิน/ซูเปอร์แอดมินเรียก resolver ตรวจใบประกอบฯ ได้', () => {
      const roles = Reflect.getMetadata(ROLES_KEY, AdminLicenseResolver);
      expect(roles).toEqual([ROLE_ID.ADMIN, ROLE_ID.SUPER_ADMIN]);
      expect(roles).not.toContain(ROLE_ID.CAREGIVER);
    });
  });
});
