/**
 * adminKycDetail - ใบขับขี่ (PYG-597: AC4 ข้อมูลที่ส่งให้หน้า KYC review ของแอดมิน)
 */
import { Test } from '@nestjs/testing';
import { AdminService } from './admin.service';
import { PrismaService } from '../common/prisma.service';
import { SupabaseService } from '../common/supabase.service';
import { CaregiverService } from '../identity/kyc/caregiver.service';
import { NotificationService } from '../notification/notification.service';
import { EmailService } from '../email/email.service';
import { PayoutAccountService } from '../payment/payout-account.service';
import { ClockService } from '../common/clock.service';
import { DrivingLicenseService } from '../identity/kyc/driving-license/driving-license.service';

const CG = 'cg-1';

describe('AdminService.adminKycDetail - drivingLicense (PYG-597)', () => {
  let service: AdminService;
  let kycReviewFindMany: jest.Mock;
  let getState: jest.Mock;

  beforeEach(async () => {
    kycReviewFindMany = jest.fn(({ where }: { where: Record<string, unknown> }) =>
      Promise.resolve(
        where.documentId === null
          ? []
          : [
              {
                id: 'r2',
                action: 'driving_license_approved',
                reason: null,
                reviewerId: 'admin-2',
                reviewedAt: new Date('2026-10-10'),
                documentId: 'dl-2',
                reviewer: { displayName: 'Admin B' },
              },
              {
                id: 'r1',
                action: 'driving_license_rejected',
                reason: 'รูปไม่ชัด',
                reviewerId: 'admin-1',
                reviewedAt: new Date('2026-10-01'),
                documentId: 'dl-1',
                reviewer: { displayName: 'Admin A' },
              },
            ],
      ),
    );
    getState = jest.fn().mockResolvedValue({
      verified: true,
      status: 'approved',
      documentId: 'dl-2',
      expiresAt: new Date('2027-01-01T16:59:59.999Z'),
      isExpired: false,
    });

    const prisma = {
      caregiver: {
        findUnique: jest.fn().mockResolvedValue({
          id: CG,
          userId: 'u1',
          profession: 'general_caregiver',
          resubmitCount: 0,
          kycStatus: 'verified',
          skills: [],
          languages: [],
          user: { email: 'a@b.c' },
        }),
      },
      kycReview: { findMany: kycReviewFindMany },
      $queryRaw: jest.fn().mockResolvedValue([]),
      caregiverPayoutAccount: { findUnique: jest.fn().mockResolvedValue(null) },
      kycDocument: { findFirst: jest.fn().mockResolvedValue(null) },
    };

    const mod = await Test.createTestingModule({
      providers: [
        AdminService,
        { provide: PrismaService, useValue: prisma },
        { provide: SupabaseService, useValue: {} },
        {
          provide: CaregiverService,
          useValue: {
            getDocumentsForAdminReview: jest.fn().mockResolvedValue([
              {
                id: 'dl-2',
                docType: 'driving_license',
                fileName: 'dl2.jpg',
                signedUrl: 'https://signed/dl2.jpg',
                reviewStatus: 'approved',
              },
            ]),
          },
        },
        { provide: NotificationService, useValue: {} },
        { provide: EmailService, useValue: {} },
        { provide: PayoutAccountService, useValue: {} },
        { provide: DrivingLicenseService, useValue: { getState } },
        ClockService,
      ],
    }).compile();
    service = mod.get(AdminService);
    jest.spyOn(service['logger'], 'log').mockImplementation();
  });

  it('ส่งผลตรวจ ไฟล์ (signed URL) วันหมดอายุ และ isExpired ที่ BE คำนวณ', async () => {
    const detail = await service.adminKycDetail(CG, 'admin-1');

    expect(getState).toHaveBeenCalledWith({ caregiverId: CG, userId: 'u1' });
    expect(detail.drivingLicense).toMatchObject({
      verified: true,
      status: 'approved',
      documentId: 'dl-2',
      fileName: 'dl2.jpg',
      signedUrl: 'https://signed/dl2.jpg',
      isExpired: false,
    });
    expect(detail.drivingLicense.expiresAt).toEqual(new Date('2027-01-01T16:59:59.999Z'));
  });

  it('ส่งประวัติการตรวจทุกรอบ (ใหม่สุดก่อน) พร้อมเหตุผลของรอบที่ปฏิเสธ (E7)', async () => {
    const detail = await service.adminKycDetail(CG, 'admin-1');

    expect(detail.drivingLicenseReviews.map((r) => [r.action, r.reason, r.documentId, r.reviewerName])).toEqual([
      ['driving_license_approved', undefined, 'dl-2', 'Admin B'],
      ['driving_license_rejected', 'รูปไม่ชัด', 'dl-1', 'Admin A'],
    ]);
  });

  it('ประวัติ KYC ทั้งก้อน (reviews) ไม่ปนกับประวัติใบขับขี่', async () => {
    const detail = await service.adminKycDetail(CG, 'admin-1');
    expect(detail.reviews).toEqual([]);
    const licenseCall = kycReviewFindMany.mock.calls.find(([a]) => a.where.action);
    expect(licenseCall?.[0].where).toEqual({
      caregiverId: CG,
      action: { in: ['driving_license_approved', 'driving_license_rejected'] },
    });
  });
});
