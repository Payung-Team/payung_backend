/**
 * PayoutAccountService tests (PYG-266)
 *
 * ครอบคลุม:
 *  - createRecipientForCaregiver: ไม่มีบัญชี → no-op, มี omiseRecipientId แล้ว → skip,
 *    happy path → สร้าง recipient + update DB, Omise fail → caught ไม่ throw ออกไป
 *  - reconcileRecipient: ไม่พบ recipientId → skip, idempotent เมื่อสถานะตรง,
 *    verified/active/pending/failed transitions และไม่เดาสถานะเมื่อ re-fetch ล้มเหลว
 */
import { Test, TestingModule } from '@nestjs/testing';
import { PayoutAccountService } from './payout-account.service';
import { PrismaService } from '../common/prisma.service';
import { OmiseService } from './omise/omise.service';
import { PayoutEncryptionService } from '../common/crypto/payout-encryption.service';
import { PaymentError } from './errors/omise-error-mapper';

const CAREGIVER_ID = 'cgrow-1';
const RECIPIENT_ID = 'recp_test_1';

describe('PayoutAccountService (PYG-266)', () => {
  let service: PayoutAccountService;
  let prisma: {
    caregiverPayoutAccount: { findUnique: jest.Mock; findFirst: jest.Mock; update: jest.Mock };
  };
  let omise: { createRecipient: jest.Mock; retrieveRecipient: jest.Mock };
  let payoutEncryption: { decrypt: jest.Mock };

  beforeEach(async () => {
    prisma = {
      caregiverPayoutAccount: {
        findUnique: jest.fn(),
        findFirst: jest.fn(),
        update: jest.fn(),
      },
    };
    omise = { createRecipient: jest.fn(), retrieveRecipient: jest.fn() };
    payoutEncryption = { decrypt: jest.fn().mockReturnValue('1234566789') };

    const moduleRef: TestingModule = await Test.createTestingModule({
      providers: [
        PayoutAccountService,
        { provide: PrismaService, useValue: prisma },
        { provide: OmiseService, useValue: omise },
        { provide: PayoutEncryptionService, useValue: payoutEncryption },
      ],
    }).compile();

    service = moduleRef.get(PayoutAccountService);
  });

  describe('createRecipientForCaregiver', () => {
    it('ไม่มีบัญชีรับเงินเลย → log + return โดยไม่เรียก Omise', async () => {
      prisma.caregiverPayoutAccount.findUnique.mockResolvedValueOnce(null);

      await service.createRecipientForCaregiver(CAREGIVER_ID, 'สมชาย ใจดี', 'a@b.com');

      expect(omise.createRecipient).not.toHaveBeenCalled();
      expect(prisma.caregiverPayoutAccount.update).not.toHaveBeenCalled();
    });

    it('มี omiseRecipientId อยู่แล้ว → skip (idempotent)', async () => {
      prisma.caregiverPayoutAccount.findUnique.mockResolvedValueOnce({
        caregiverId: CAREGIVER_ID,
        omiseRecipientId: RECIPIENT_ID,
        accountNumberEnc: 'iv:tag:ct',
        bankCode: 'kbank',
        accountName: 'สมชาย ใจดี',
      });

      await service.createRecipientForCaregiver(CAREGIVER_ID, 'สมชาย ใจดี', 'a@b.com');

      expect(omise.createRecipient).not.toHaveBeenCalled();
    });

    it('happy path: decrypt เลขบัญชี → createRecipient → update omiseRecipientId + status=active', async () => {
      prisma.caregiverPayoutAccount.findUnique.mockResolvedValueOnce({
        caregiverId: CAREGIVER_ID,
        omiseRecipientId: null,
        accountNumberEnc: 'iv:tag:ct',
        bankCode: 'kbank',
        accountName: 'สมชาย ใจดี',
      });
      omise.createRecipient.mockResolvedValueOnce({
        id: RECIPIENT_ID,
        verified: false,
        active: true,
        bankAccount: { brand: 'kbank', lastDigits: '6789', name: 'สมชาย ใจดี' },
      });

      await service.createRecipientForCaregiver(CAREGIVER_ID, 'สมชาย ใจดี', 'a@b.com');

      expect(payoutEncryption.decrypt).toHaveBeenCalledWith('iv:tag:ct');
      expect(omise.createRecipient).toHaveBeenCalledWith({
        name: 'สมชาย ใจดี',
        email: 'a@b.com',
        bankCode: 'kbank',
        accountNumber: '1234566789',
        accountName: 'สมชาย ใจดี',
      });
      expect(prisma.caregiverPayoutAccount.update).toHaveBeenCalledWith({
        where: { caregiverId: CAREGIVER_ID },
        data: { omiseRecipientId: RECIPIENT_ID, recipientStatus: 'pending' },
      });
    });

    it('Omise createRecipient ล้มเหลว → caught ไม่ throw ออกจาก method', async () => {
      prisma.caregiverPayoutAccount.findUnique.mockResolvedValueOnce({
        caregiverId: CAREGIVER_ID,
        omiseRecipientId: null,
        accountNumberEnc: 'iv:tag:ct',
        bankCode: 'kbank',
        accountName: 'สมชาย ใจดี',
      });
      omise.createRecipient.mockRejectedValueOnce(new Error('Omise 400'));

      await expect(
        service.createRecipientForCaregiver(CAREGIVER_ID, 'สมชาย ใจดี', 'a@b.com'),
      ).resolves.toBeUndefined();

      expect(prisma.caregiverPayoutAccount.update).not.toHaveBeenCalled();
    });

    // ── TASK 4: Omise คือตัวตัดสินสุดท้ายเรื่องความถูกต้องของเลขบัญชี ──────────
    it('Omise ปฏิเสธด้วย 4xx (เลขบัญชีผิด) → mark recipientStatus=failed ไม่ปล่อยค้างเงียบ', async () => {
      prisma.caregiverPayoutAccount.findUnique.mockResolvedValueOnce({
        caregiverId: CAREGIVER_ID,
        omiseRecipientId: null,
        accountNumberEnc: 'iv:tag:ct',
        bankCode: 'kbank',
        accountName: 'สมชาย ใจดี',
      });
      omise.createRecipient.mockRejectedValueOnce(
        new PaymentError('PAYMENT_FAILED', 'บัญชีไม่ถูกต้อง', 'invalid bank account', {
          httpStatus: 400,
          omiseCode: 'invalid_request',
        }),
      );

      await service.createRecipientForCaregiver(CAREGIVER_ID, 'สมชาย ใจดี', 'a@b.com');

      expect(prisma.caregiverPayoutAccount.update).toHaveBeenCalledWith({
        where: { caregiverId: CAREGIVER_ID },
        data: { recipientStatus: 'failed', status: 'pending' },
      });
    });

    it('Omise ล่ม 5xx → คง unverified ไว้ให้ลองใหม่ ไม่ mark failed', async () => {
      prisma.caregiverPayoutAccount.findUnique.mockResolvedValueOnce({
        caregiverId: CAREGIVER_ID,
        omiseRecipientId: null,
        accountNumberEnc: 'iv:tag:ct',
        bankCode: 'kbank',
        accountName: 'สมชาย ใจดี',
      });
      omise.createRecipient.mockRejectedValueOnce(
        new PaymentError('PAYMENT_FAILED', 'ระบบขัดข้อง', 'omise down', {
          httpStatus: 503,
        }),
      );

      await service.createRecipientForCaregiver(CAREGIVER_ID, 'สมชาย ใจดี', 'a@b.com');

      expect(prisma.caregiverPayoutAccount.update).not.toHaveBeenCalled();
    });
  });

  describe('reconcileRecipient', () => {
    const bankAccount = { brand: 'kbank', lastDigits: '6789', name: 'x' };

    it('ไม่พบ payout account จาก recipientId → return null', async () => {
      prisma.caregiverPayoutAccount.findFirst.mockResolvedValueOnce(null);

      await expect(
        service.reconcileRecipient(RECIPIENT_ID, 'recipient.verify'),
      ).resolves.toBeNull();

      expect(omise.retrieveRecipient).not.toHaveBeenCalled();
      expect(prisma.caregiverPayoutAccount.update).not.toHaveBeenCalled();
    });

    it('verified และ active แล้ว → skip DB update แบบ idempotent', async () => {
      prisma.caregiverPayoutAccount.findFirst.mockResolvedValueOnce({
        id: 'payout-1',
        recipientStatus: 'verified',
        status: 'active',
        verifiedAt: new Date(),
      });
      omise.retrieveRecipient.mockResolvedValueOnce({
        id: RECIPIENT_ID,
        verified: true,
        active: true,
        failureCode: null,
        bankAccount,
      });

      await expect(
        service.reconcileRecipient(RECIPIENT_ID, 'recipient.activate'),
      ).resolves.toEqual({ recipientStatus: 'verified', status: 'active' });

      expect(prisma.caregiverPayoutAccount.update).not.toHaveBeenCalled();
    });

    it('verified แต่ยังไม่ active → verified/pending และยังไม่พร้อมโอน', async () => {
      prisma.caregiverPayoutAccount.findFirst.mockResolvedValueOnce({
        id: 'payout-1',
        recipientStatus: 'pending',
        status: 'pending',
        verifiedAt: null,
      });
      omise.retrieveRecipient.mockResolvedValueOnce({
        id: RECIPIENT_ID,
        verified: true,
        active: false,
        failureCode: null,
        bankAccount,
      });

      await service.reconcileRecipient(RECIPIENT_ID, 'recipient.verify');

      expect(prisma.caregiverPayoutAccount.update).toHaveBeenCalledWith({
        where: { id: 'payout-1' },
        data: {
          recipientStatus: 'verified',
          status: 'pending',
          verifiedAt: expect.any(Date),
        },
      });
    });

    it('verified และ active → verified/active', async () => {
      prisma.caregiverPayoutAccount.findFirst.mockResolvedValueOnce({
        id: 'payout-1',
        recipientStatus: 'pending',
        status: 'pending',
        verifiedAt: null,
      });
      omise.retrieveRecipient.mockResolvedValueOnce({
        id: RECIPIENT_ID,
        verified: true,
        active: true,
        failureCode: null,
        bankAccount,
      });

      await service.reconcileRecipient(RECIPIENT_ID, 'recipient.activate');

      expect(prisma.caregiverPayoutAccount.update).toHaveBeenCalledWith({
        where: { id: 'payout-1' },
        data: {
          recipientStatus: 'verified',
          status: 'active',
          verifiedAt: expect.any(Date),
        },
      });
    });

    it('ยังตรวจไม่เสร็จและไม่มี failure code → pending/pending', async () => {
      prisma.caregiverPayoutAccount.findFirst.mockResolvedValueOnce({
        id: 'payout-1',
        recipientStatus: 'unverified',
        status: 'pending',
        verifiedAt: null,
      });
      omise.retrieveRecipient.mockResolvedValueOnce({
        id: RECIPIENT_ID,
        verified: false,
        active: false,
        failureCode: null,
        bankAccount,
      });

      await service.reconcileRecipient(RECIPIENT_ID, 'recipient.update');

      expect(prisma.caregiverPayoutAccount.update).toHaveBeenCalledWith({
        where: { id: 'payout-1' },
        data: {
          recipientStatus: 'pending',
          status: 'pending',
          verifiedAt: null,
        },
      });
    });

    it('มี failure code → failed/pending', async () => {
      prisma.caregiverPayoutAccount.findFirst.mockResolvedValueOnce({
        id: 'payout-1',
        recipientStatus: 'pending',
        status: 'pending',
        verifiedAt: null,
      });
      omise.retrieveRecipient.mockResolvedValueOnce({
        id: RECIPIENT_ID,
        verified: false,
        active: false,
        failureCode: 'account_not_found',
        bankAccount,
      });

      await service.reconcileRecipient(RECIPIENT_ID, 'recipient.update');

      expect(prisma.caregiverPayoutAccount.update).toHaveBeenCalledWith({
        where: { id: 'payout-1' },
        data: {
          recipientStatus: 'failed',
          status: 'pending',
          verifiedAt: null,
        },
      });
    });

    it('retrieve จาก Omise ล้มเหลว → ไม่เดาสถานะจาก event', async () => {
      prisma.caregiverPayoutAccount.findFirst.mockResolvedValueOnce({
        id: 'payout-1',
        recipientStatus: 'pending',
        status: 'pending',
        verifiedAt: null,
      });
      omise.retrieveRecipient.mockRejectedValueOnce(new Error('network error'));

      await expect(
        service.reconcileRecipient(RECIPIENT_ID, 'recipient.verify'),
      ).rejects.toThrow('network error');
      expect(prisma.caregiverPayoutAccount.update).not.toHaveBeenCalled();
    });
  });
});
