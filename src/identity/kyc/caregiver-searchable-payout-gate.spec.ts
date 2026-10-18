/**
 * setSearchableByUser — gate บัญชีรับเงิน (ตัวเลือก C: อนุมัติ KYC ได้ แต่เปิดรับงานต้องรอ Omise accept)
 */
import { ForbiddenException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { CaregiverService } from './caregiver.service';
import { PrismaService } from '../../common/prisma.service';
import { SupabaseService } from '../../common/supabase.service';
import { PAYOUT_ACCOUNT_NOT_READY } from '../../payment/payout-account-readiness';

const USER_ID = 'user-1';

describe('CaregiverService.setSearchableByUser — payout gate', () => {
  let service: CaregiverService;
  let prisma: {
    caregiver: { findUnique: jest.Mock; update: jest.Mock };
    caregiverPayoutAccount: { findUnique: jest.Mock };
  };

  const caregiverRow = (over: Record<string, unknown> = {}) => ({
    id: 'cg-1',
    userId: USER_ID,
    kycStatus: 'verified',
    isSearchable: false,
    skills: [],
    languages: [],
    createdAt: new Date(),
    updatedAt: new Date(),
    ...over,
  });

  beforeEach(() => {
    prisma = {
      caregiver: {
        findUnique: jest.fn().mockResolvedValue(caregiverRow()),
        update: jest
          .fn()
          .mockImplementation(({ data }) => Promise.resolve(caregiverRow(data))),
      },
      caregiverPayoutAccount: { findUnique: jest.fn() },
    };
    service = new CaregiverService(
      prisma as unknown as PrismaService,
      {} as SupabaseService,
      {} as ConfigService,
    );
  });

  const activeAccount = {
    status: 'active',
    recipientStatus: 'verified',
    omiseRecipientId: 'recp_1',
  };

  it('Omise accept แล้ว (active + verified) → เปิดรับงานได้', async () => {
    prisma.caregiverPayoutAccount.findUnique.mockResolvedValueOnce(activeAccount);

    const res = await service.setSearchableByUser(USER_ID, true);

    expect(res.isSearchable).toBe(true);
    expect(prisma.caregiver.update).toHaveBeenCalledWith({
      where: { userId: USER_ID },
      data: { isSearchable: true },
    });
  });

  it.each([
    ['NO_ACCOUNT', null],
    ['PENDING', { status: 'pending', recipientStatus: 'pending', omiseRecipientId: 'recp_1' }],
    ['PENDING', { status: 'pending', recipientStatus: 'unverified', omiseRecipientId: null }],
    ['FAILED', { status: 'pending', recipientStatus: 'failed', omiseRecipientId: null }],
  ])('reason=%s → ForbiddenException และไม่อัปเดต isSearchable', async (reason, account) => {
    prisma.caregiverPayoutAccount.findUnique.mockResolvedValueOnce(account);

    const err = await service.setSearchableByUser(USER_ID, true).catch((e) => e);

    expect(err).toBeInstanceOf(ForbiddenException);
    expect(err.getResponse()).toMatchObject({ code: PAYOUT_ACCOUNT_NOT_READY, reason });
    expect(prisma.caregiver.update).not.toHaveBeenCalled();
  });

  it('ปิดรับงาน (false) ทำได้เสมอ แม้บัญชียังไม่ผ่าน — ไม่เช็คบัญชี', async () => {
    prisma.caregiver.findUnique.mockResolvedValueOnce(caregiverRow({ isSearchable: true }));

    const res = await service.setSearchableByUser(USER_ID, false);

    expect(res.isSearchable).toBe(false);
    expect(prisma.caregiverPayoutAccount.findUnique).not.toHaveBeenCalled();
  });

  it('KYC ยังไม่ verified → ถูกบล็อกก่อนเช็คบัญชี', async () => {
    prisma.caregiver.findUnique.mockResolvedValueOnce(caregiverRow({ kycStatus: 'pending' }));

    await expect(service.setSearchableByUser(USER_ID, true)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    expect(prisma.caregiverPayoutAccount.findUnique).not.toHaveBeenCalled();
  });
});
