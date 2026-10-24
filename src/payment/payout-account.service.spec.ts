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
import { NotificationService } from '../notification/notification.service';
import { NotificationType } from '../notification/entities/notification-type.enum';

const CAREGIVER_ID = 'cgrow-1';
const RECIPIENT_ID = 'recp_test_1';

describe('PayoutAccountService (PYG-266)', () => {
  let service: PayoutAccountService;
  let prisma: {
    caregiverPayoutAccount: { findUnique: jest.Mock; findFirst: jest.Mock; findMany: jest.Mock; update: jest.Mock };
    caregiver: { findUnique: jest.Mock };
  };
  let notifications: { create: jest.Mock };
  let omise: { createRecipient: jest.Mock; retrieveRecipient: jest.Mock; verifyRecipient: jest.Mock; isTestMode: boolean };
  let payoutEncryption: { decrypt: jest.Mock };

  beforeEach(async () => {
    prisma = {
      caregiverPayoutAccount: {
        findUnique: jest.fn(),
        findFirst: jest.fn(),
        findMany: jest.fn(),
        update: jest.fn(),
      },
      caregiver: { findUnique: jest.fn().mockResolvedValue({ userId: 'user-1' }) },
    };
    notifications = { create: jest.fn().mockResolvedValue({}) };
    omise = { createRecipient: jest.fn(), retrieveRecipient: jest.fn(), verifyRecipient: jest.fn(), isTestMode: false };
    payoutEncryption = { decrypt: jest.fn().mockReturnValue('1234566789') };

    const moduleRef: TestingModule = await Test.createTestingModule({
      providers: [
        PayoutAccountService,
        { provide: PrismaService, useValue: prisma },
        { provide: OmiseService, useValue: omise },
        { provide: PayoutEncryptionService, useValue: payoutEncryption },
        { provide: NotificationService, useValue: notifications },
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
      await new Promise(setImmediate);
      expect(notifications.create).toHaveBeenCalledWith(
        'user-1',
        NotificationType.payout_account_failed,
        expect.any(String),
        expect.any(String),
        expect.objectContaining({ caregiverId: CAREGIVER_ID }),
      );
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

    // ── Option C: แจ้ง caregiver เมื่อ Omise accept / ปฏิเสธ ────────────────────
    const pendingRow = {
      id: 'payout-1',
      caregiverId: CAREGIVER_ID,
      recipientStatus: 'pending',
      status: 'pending',
      verifiedAt: null,
    };

    it('เปลี่ยนเป็น active → แจ้ง payout_account_verified ให้ caregiver', async () => {
      prisma.caregiverPayoutAccount.findFirst.mockResolvedValueOnce(pendingRow);
      omise.retrieveRecipient.mockResolvedValueOnce({
        id: RECIPIENT_ID, verified: true, active: true, failureCode: null, bankAccount,
      });

      await service.reconcileRecipient(RECIPIENT_ID, 'recipient.activate');
      await new Promise(setImmediate);

      expect(notifications.create).toHaveBeenCalledTimes(1);
      expect(notifications.create).toHaveBeenCalledWith(
        'user-1',
        NotificationType.payout_account_verified,
        expect.any(String),
        expect.any(String),
        expect.objectContaining({ caregiverId: CAREGIVER_ID }),
      );
    });

    it('test mode + ยังไม่ verified → เรียก Mark as verified แล้วตั้ง active', async () => {
      omise.isTestMode = true;
      prisma.caregiverPayoutAccount.findFirst.mockResolvedValueOnce(pendingRow);
      omise.retrieveRecipient.mockResolvedValueOnce({
        id: RECIPIENT_ID, verified: false, active: true, failureCode: null, bankAccount,
      });
      omise.verifyRecipient.mockResolvedValueOnce({
        id: RECIPIENT_ID, verified: true, active: true, failureCode: null, bankAccount,
      });

      const r = await service.reconcileRecipient(RECIPIENT_ID, 'cron.sync');

      expect(omise.verifyRecipient).toHaveBeenCalledWith(RECIPIENT_ID);
      expect(r).toEqual({ recipientStatus: 'verified', status: 'active' });
    });

    it('live mode + verified แต่ยังไม่ active → ยังเป็น pending และไม่เรียก verify', async () => {
      prisma.caregiverPayoutAccount.findFirst.mockResolvedValueOnce(pendingRow);
      omise.retrieveRecipient.mockResolvedValueOnce({
        id: RECIPIENT_ID, verified: true, active: false, failureCode: null, bankAccount,
      });

      const r = await service.reconcileRecipient(RECIPIENT_ID, 'recipient.verify');

      expect(omise.verifyRecipient).not.toHaveBeenCalled();
      expect(r).toEqual({ recipientStatus: 'verified', status: 'pending' });
    });

    it('Omise ส่ง failure_code → แจ้ง payout_account_failed ให้ caregiver', async () => {
      prisma.caregiverPayoutAccount.findFirst.mockResolvedValueOnce(pendingRow);
      omise.retrieveRecipient.mockResolvedValueOnce({
        id: RECIPIENT_ID, verified: false, active: false, failureCode: 'invalid_account', bankAccount,
      });

      await service.reconcileRecipient(RECIPIENT_ID, 'recipient.verify');
      await new Promise(setImmediate);

      expect(notifications.create).toHaveBeenCalledWith(
        'user-1',
        NotificationType.payout_account_failed,
        expect.any(String),
        expect.any(String),
        expect.any(Object),
      );
    });

    it('webhook ซ้ำตอน active อยู่แล้ว → ไม่แจ้งซ้ำ', async () => {
      prisma.caregiverPayoutAccount.findFirst.mockResolvedValueOnce({
        ...pendingRow, recipientStatus: 'verified', status: 'active', verifiedAt: new Date(),
      });
      omise.retrieveRecipient.mockResolvedValueOnce({
        id: RECIPIENT_ID, verified: true, active: true, failureCode: null, bankAccount,
      });

      await service.reconcileRecipient(RECIPIENT_ID, 'recipient.activate');
      await new Promise(setImmediate);

      expect(notifications.create).not.toHaveBeenCalled();
    });

    it('แจ้งเตือนล้มเหลว → reconcile ยังสำเร็จ ไม่ throw', async () => {
      notifications.create.mockRejectedValueOnce(new Error('db down'));
      prisma.caregiverPayoutAccount.findFirst.mockResolvedValueOnce(pendingRow);
      omise.retrieveRecipient.mockResolvedValueOnce({
        id: RECIPIENT_ID, verified: true, active: true, failureCode: null, bankAccount,
      });

      await expect(
        service.reconcileRecipient(RECIPIENT_ID, 'recipient.activate'),
      ).resolves.toEqual({ recipientStatus: 'verified', status: 'active' });
      await new Promise(setImmediate);
    });

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

  describe('syncPendingRecipients (cron สำรอง webhook)', () => {
    const fresh = { id: RECIPIENT_ID, verified: true, active: true, failureCode: null, bankAccount: {} };

    afterEach(() => {
      delete process.env.PAYOUT_RECIPIENT_SYNC_ENABLED;
    });

    it('query เฉพาะบัญชีที่มี recipientId และยังไม่ active+verified', async () => {
      prisma.caregiverPayoutAccount.findMany.mockResolvedValueOnce([]);

      await expect(service.syncPendingRecipients()).resolves.toBe(0);

      expect(prisma.caregiverPayoutAccount.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            omiseRecipientId: { not: null },
            OR: [{ status: { not: 'active' } }, { recipientStatus: { not: 'verified' } }],
          },
          take: 50,
        }),
      );
      expect(omise.retrieveRecipient).not.toHaveBeenCalled();
    });

    it('pending → Omise active แล้ว → อัปเดต DB + แจ้ง caregiver', async () => {
      prisma.caregiverPayoutAccount.findMany.mockResolvedValueOnce([{ omiseRecipientId: RECIPIENT_ID }]);
      prisma.caregiverPayoutAccount.findFirst.mockResolvedValueOnce({
        id: 'payout-1', caregiverId: CAREGIVER_ID, omiseRecipientId: RECIPIENT_ID,
        recipientStatus: 'pending', status: 'pending', verifiedAt: null,
      });
      omise.retrieveRecipient.mockResolvedValueOnce(fresh);

      await expect(service.syncPendingRecipients()).resolves.toBe(1);
      await new Promise(setImmediate);

      expect(prisma.caregiverPayoutAccount.update).toHaveBeenCalled();
      expect(notifications.create).toHaveBeenCalledWith(
        'user-1', NotificationType.payout_account_verified,
        expect.any(String), expect.any(String), expect.any(Object),
      );
    });

    it('ตัวหนึ่ง Omise error → ข้ามไปตัวถัดไป ไม่ throw', async () => {
      prisma.caregiverPayoutAccount.findMany.mockResolvedValueOnce([
        { omiseRecipientId: 'recp_a' }, { omiseRecipientId: 'recp_b' },
      ]);
      prisma.caregiverPayoutAccount.findFirst
        .mockResolvedValueOnce({ id: 'p1', caregiverId: 'c1', recipientStatus: 'pending', status: 'pending', verifiedAt: null })
        .mockResolvedValueOnce({ id: 'p2', caregiverId: 'c2', recipientStatus: 'pending', status: 'pending', verifiedAt: null });
      omise.retrieveRecipient.mockRejectedValueOnce(new Error('omise 503')).mockResolvedValueOnce(fresh);

      await expect(service.syncPendingRecipients()).resolves.toBe(1);
      expect(omise.retrieveRecipient).toHaveBeenCalledTimes(2);
    });

    it('PAYOUT_RECIPIENT_SYNC_ENABLED=false → ไม่ทำอะไร', async () => {
      process.env.PAYOUT_RECIPIENT_SYNC_ENABLED = 'false';

      await expect(service.syncPendingRecipients()).resolves.toBe(0);
      expect(prisma.caregiverPayoutAccount.findMany).not.toHaveBeenCalled();
    });
  });
});
