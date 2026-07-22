/**
 * KycService — payout account tests (PYG-266)
 *
 * ครอบคลุมเฉพาะส่วนที่เกี่ยวกับบัญชีรับเงิน (ไม่ครอบ KYC flow เดิมที่ไม่ได้แก้):
 *  - submitKyc: มี payoutAccount → upsert เข้ารหัส + last4; ไม่มี → ไม่แตะ caregiverPayoutAccount
 *  - edit log ไม่มี plaintext/ciphertext เลขบัญชี — มีแค่ ***last4
 *  - updatePayoutAccount: reject เมื่อ kycStatus !== 'verified'; happy path → upsert +
 *    createRecipientForCaregiver ถูกเรียก
 *  - getKycStatus: payoutAccount undefined เมื่อไม่มี, มี summary แบบ mask เมื่อมี
 */
import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { KycService } from './kyc.service';
import { PrismaService } from '../../common/prisma.service';
import { CaregiverService } from './caregiver.service';
import { NotificationService } from '../../notification/notification.service';
import { EmailService } from '../../email/email.service';
import { PayoutEncryptionService } from '../../common/crypto/payout-encryption.service';
import { PayoutAccountService } from '../../payment/payout-account.service';
import { AuthUser } from '../../common/decorators/current-user.decorator';
import { KycInput } from './dto/kyc.input';

const USER_ID = 'user-1';
const CAREGIVER_ID = 'cgrow-1';

function baseKycInput(overrides: Partial<KycInput> = {}): KycInput {
  return {
    fullName: 'สมชาย ใจดี',
    idCardNumber: '1234567890123',
    phone: '0812345678',
    skills: ['elder_care'],
    experienceYears: 3,
    hourlyRate: 150,
    documentIds: [],
    ...overrides,
  } as KycInput;
}

describe('KycService — payout account (PYG-266)', () => {
  let service: KycService;
  let prisma: {
    caregiver: { findUnique: jest.Mock };
    kycDocument: { findMany: jest.Mock };
    caregiverPayoutAccount: { findUnique: jest.Mock };
    $transaction: jest.Mock;
  };
  let tx: {
    caregiver: { upsert: jest.Mock };
    kycDocument: { findMany: jest.Mock; updateMany: jest.Mock };
    caregiverPayoutAccount: { findUnique: jest.Mock; upsert: jest.Mock };
    $executeRaw: jest.Mock;
  };
  let payoutEncryption: { encrypt: jest.Mock; last4: jest.Mock; decrypt: jest.Mock };
  let payoutAccountService: { createRecipientForCaregiver: jest.Mock };

  beforeEach(async () => {
    tx = {
      caregiver: {
        upsert: jest.fn().mockResolvedValue({ id: CAREGIVER_ID, resubmitCount: 0 }),
      },
      kycDocument: { findMany: jest.fn().mockResolvedValue([]), updateMany: jest.fn() },
      caregiverPayoutAccount: { findUnique: jest.fn(), upsert: jest.fn() },
      $executeRaw: jest.fn(),
    };
    prisma = {
      caregiver: { findUnique: jest.fn() },
      kycDocument: { findMany: jest.fn().mockResolvedValue([]) },
      caregiverPayoutAccount: { findUnique: jest.fn() },
      $transaction: jest.fn((cb: (t: typeof tx) => unknown) => cb(tx)),
    };
    payoutEncryption = {
      encrypt: jest.fn().mockReturnValue('iv:tag:ct'),
      last4: jest.fn((num: string) => num.slice(-4)),
      decrypt: jest.fn(),
    };
    payoutAccountService = { createRecipientForCaregiver: jest.fn().mockResolvedValue(undefined) };

    const moduleRef: TestingModule = await Test.createTestingModule({
      providers: [
        KycService,
        { provide: PrismaService, useValue: prisma },
        {
          provide: CaregiverService,
          useValue: {
            generateCaregiverNumber: jest.fn().mockResolvedValue('CG-260101-0001'),
            getDocumentsWithSignedUrls: jest.fn().mockResolvedValue([]),
          },
        },
        { provide: NotificationService, useValue: { create: jest.fn() } },
        {
          provide: EmailService,
          useValue: { sendKycSubmitted: jest.fn(), sendKycResubmitted: jest.fn() },
        },
        { provide: PayoutEncryptionService, useValue: payoutEncryption },
        { provide: PayoutAccountService, useValue: payoutAccountService },
      ],
    }).compile();

    service = moduleRef.get(KycService);
  });

  describe('submitKyc — payoutAccount', () => {
    it('ไม่ส่ง payoutAccount มา → ไม่แตะ caregiverPayoutAccount เลย', async () => {
      prisma.caregiver.findUnique.mockResolvedValueOnce(null);
      const user: AuthUser = { id: USER_ID, email: 'x@y.com' } as AuthUser;

      await service.submitKyc(user, baseKycInput());

      expect(tx.caregiverPayoutAccount.upsert).not.toHaveBeenCalled();
    });

    it('ส่ง payoutAccount มา (first submit) → encrypt + upsert create branch, status=pending/unverified', async () => {
      prisma.caregiver.findUnique.mockResolvedValueOnce(null);
      tx.caregiverPayoutAccount.findUnique.mockResolvedValueOnce(null);
      tx.caregiverPayoutAccount.upsert.mockResolvedValueOnce({
        id: 'payout-1',
        caregiverId: CAREGIVER_ID,
        bankCode: 'kbank',
        accountName: 'สมชาย ใจดี',
        accountNumberEnc: 'iv:tag:ct',
        accountNumberLast4: '6789',
        status: 'pending',
        recipientStatus: 'unverified',
        omiseRecipientId: null,
        verifiedAt: null,
      });
      const user: AuthUser = { id: USER_ID, email: 'x@y.com' } as AuthUser;

      await service.submitKyc(
        user,
        baseKycInput({
          payoutAccount: { bankCode: 'kbank', accountNumber: '1234566789', accountName: 'สมชาย ใจดี' },
        }),
      );

      expect(payoutEncryption.encrypt).toHaveBeenCalledWith('1234566789');
      expect(tx.caregiverPayoutAccount.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { caregiverId: CAREGIVER_ID },
          create: expect.objectContaining({
            bankCode: 'kbank',
            accountName: 'สมชาย ใจดี',
            accountNumberEnc: 'iv:tag:ct',
            accountNumberLast4: '6789',
            status: 'pending',
            recipientStatus: 'unverified',
          }),
        }),
      );

      // edit log ต้องไม่มี plaintext/ciphertext เลขบัญชีเลย — มีแค่ ***last4
      // tagged template: $executeRaw(stringsArray, upserted.id, user.id, action, changesJson)
      const rawSqlArgs = tx.$executeRaw.mock.calls[0];
      const changesJson: string = rawSqlArgs[4];
      expect(changesJson).not.toContain('1234566789');
      expect(changesJson).not.toContain('iv:tag:ct');
      expect(changesJson).toContain('***6789');
    });

    it('resubmit ด้วยบัญชีใหม่ (update branch) → reset omiseRecipientId/recipientStatus/status', async () => {
      prisma.caregiver.findUnique.mockResolvedValueOnce({
        id: CAREGIVER_ID,
        kycStatus: 'rejected',
        resubmitCount: 0,
        caregiverNumber: 'CG-260101-0001',
      });
      tx.caregiverPayoutAccount.findUnique.mockResolvedValueOnce({
        caregiverId: CAREGIVER_ID,
        bankCode: 'scb',
        accountName: 'เก่า',
        accountNumberLast4: '1111',
      });
      tx.caregiverPayoutAccount.upsert.mockResolvedValueOnce({
        id: 'payout-1',
        caregiverId: CAREGIVER_ID,
        bankCode: 'kbank',
        accountName: 'สมชาย ใจดี',
        accountNumberEnc: 'iv:tag:ct2',
        accountNumberLast4: '6789',
        status: 'pending',
        recipientStatus: 'unverified',
        omiseRecipientId: null,
        verifiedAt: null,
      });
      const user: AuthUser = { id: USER_ID, email: 'x@y.com' } as AuthUser;

      await service.submitKyc(
        user,
        baseKycInput({
          payoutAccount: { bankCode: 'kbank', accountNumber: '1234566789', accountName: 'สมชาย ใจดี' },
        }),
      );

      expect(tx.caregiverPayoutAccount.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          update: expect.objectContaining({
            omiseRecipientId: null,
            verifiedAt: null,
            status: 'pending',
            recipientStatus: 'unverified',
          }),
        }),
      );
    });
  });

  describe('updatePayoutAccount', () => {
    it('caregiver ไม่พบ → NotFoundException', async () => {
      prisma.caregiver.findUnique.mockResolvedValueOnce(null);
      const user: AuthUser = { id: USER_ID, email: 'x@y.com' } as AuthUser;

      await expect(
        service.updatePayoutAccount(user, {
          bankCode: 'kbank',
          accountNumber: '1234566789',
          accountName: 'x',
        }),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('kycStatus ยังไม่ verified → BadRequestException, ไม่แตะ transaction เลย', async () => {
      prisma.caregiver.findUnique.mockResolvedValueOnce({
        id: CAREGIVER_ID,
        kycStatus: 'pending',
      });
      const user: AuthUser = { id: USER_ID, email: 'x@y.com' } as AuthUser;

      await expect(
        service.updatePayoutAccount(user, {
          bankCode: 'kbank',
          accountNumber: '1234566789',
          accountName: 'x',
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('happy path: kycStatus=verified → upsert ผ่าน tx + เรียก createRecipientForCaregiver', async () => {
      prisma.caregiver.findUnique.mockResolvedValueOnce({
        id: CAREGIVER_ID,
        kycStatus: 'verified',
        fullName: 'สมชาย ใจดี',
      });
      tx.caregiverPayoutAccount.findUnique.mockResolvedValueOnce(null);
      tx.caregiverPayoutAccount.upsert.mockResolvedValueOnce({
        id: 'payout-1',
        caregiverId: CAREGIVER_ID,
        bankCode: 'kbank',
        accountName: 'สมชาย ใจดี',
        accountNumberEnc: 'iv:tag:ct',
        accountNumberLast4: '6789',
        status: 'pending',
        recipientStatus: 'unverified',
        omiseRecipientId: null,
        verifiedAt: null,
      });
      const user: AuthUser = { id: USER_ID, email: 'somchai@x.com' } as AuthUser;

      const result = await service.updatePayoutAccount(user, {
        bankCode: 'kbank',
        accountNumber: '1234566789',
        accountName: 'สมชาย ใจดี',
      });

      expect(prisma.$transaction).toHaveBeenCalled();
      expect(payoutAccountService.createRecipientForCaregiver).toHaveBeenCalledWith(
        CAREGIVER_ID,
        'สมชาย ใจดี',
        'somchai@x.com',
      );
      expect(result).toEqual({
        bankCode: 'kbank',
        accountName: 'สมชาย ใจดี',
        accountNumberLast4: '6789',
        status: 'pending',
        recipientStatus: 'unverified',
      });
      // never leaks accountNumberEnc ใน summary ที่ return
      expect(result).not.toHaveProperty('accountNumberEnc');
    });
  });

  describe('getKycStatus — payoutAccount', () => {
    it('ไม่มี caregiverPayoutAccount → payoutAccount = undefined', async () => {
      prisma.caregiver.findUnique.mockResolvedValueOnce({
        id: CAREGIVER_ID,
        kycStatus: 'pending',
        kycSubmittedAt: new Date(),
        kycVerifiedAt: null,
      });
      prisma.caregiverPayoutAccount.findUnique.mockResolvedValueOnce(null);

      const result = await service.getKycStatus(USER_ID);

      expect(result.payoutAccount).toBeUndefined();
    });

    it('มี caregiverPayoutAccount → คืน masked summary (ไม่มี accountNumberEnc)', async () => {
      prisma.caregiver.findUnique.mockResolvedValueOnce({
        id: CAREGIVER_ID,
        kycStatus: 'verified',
        kycSubmittedAt: new Date(),
        kycVerifiedAt: new Date(),
      });
      prisma.caregiverPayoutAccount.findUnique.mockResolvedValueOnce({
        bankCode: 'kbank',
        accountName: 'สมชาย ใจดี',
        accountNumberEnc: 'iv:tag:ct',
        accountNumberLast4: '6789',
        status: 'active',
        recipientStatus: 'verified',
      });

      const result = await service.getKycStatus(USER_ID);

      expect(result.payoutAccount).toEqual({
        bankCode: 'kbank',
        accountName: 'สมชาย ใจดี',
        accountNumberLast4: '6789',
        status: 'active',
        recipientStatus: 'verified',
      });
    });
  });
});
