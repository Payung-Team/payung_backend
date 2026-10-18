/**
 * KycService — payout account tests (PYG-266)
 *
 * ครอบคลุมเฉพาะส่วนที่เกี่ยวกับบัญชีรับเงิน (ไม่ครอบ KYC flow เดิมที่ไม่ได้แก้):
 *  - submitKyc: มี payoutAccount → upsert เข้ารหัส + last4; ไม่มี → ไม่แตะ caregiverPayoutAccount
 *  - edit log ไม่มี plaintext/ciphertext เลขบัญชี — มีแค่ ***last4
 *  - updatePayoutAccount: reject เมื่อ kycStatus !== 'verified'; happy path → upsert +
 *    createRecipientForCaregiver ถูกเรียก
 *  - getKycStatus: payoutAccount undefined เมื่อไม่มี, มี summary แบบ mask เมื่อมี
 *  - PYG-575: profession — บังคับ (PROFESSION_REQUIRED) · ค่านอกรายการ (PROFESSION_INVALID) ·
 *    บันทึกลงตาราง · resubmit เปลี่ยนวิชาชีพได้ทันทีพร้อม edit log (E2)
 */
import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { KycService } from './kyc.service';
import { DrivingLicenseService } from './driving-license/driving-license.service';
import { PrismaService } from '../../common/prisma.service';
import { CaregiverService } from './caregiver.service';
import { NotificationService } from '../../notification/notification.service';
import { EmailService } from '../../email/email.service';
import { ClockService } from '../../common/clock.service';
import { PayoutEncryptionService } from '../../common/crypto/payout-encryption.service';
import { PayoutAccountService } from '../../payment/payout-account.service';
import { AuthUser } from '../../common/decorators/current-user.decorator';
import { KycInput } from './dto/kyc.input';
import { CareSkillService } from '../../care-skill/care-skill.service';
import { ProfessionError } from './profession.errors';

const USER_ID = 'user-1';
const CAREGIVER_ID = 'cgrow-1';

function baseKycInput(overrides: Partial<KycInput> = {}): KycInput {
  return {
    fullName: 'สมชาย ใจดี',
    idCardNumber: '1234567890123',
    phone: '0812345678',
    skills: ['bathing'],
    experienceYears: 3,
    documentIds: [],
    // PYG-575: FE รุ่นปัจจุบันส่งเสมอ — เทสที่ต้องการ "ไม่ส่ง" ให้ override เป็น undefined เอง
    profession: 'general_caregiver',
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
    caregiver: { upsert: jest.Mock; updateMany: jest.Mock };
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
        updateMany: jest.fn().mockResolvedValue({ count: 0 }),
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
            getOwnDocumentsWithSignedUrls: jest.fn().mockResolvedValue([]),
          },
        },
        { provide: NotificationService, useValue: { create: jest.fn() } },
        {
          provide: EmailService,
          useValue: { sendKycSubmitted: jest.fn(), sendKycResubmitted: jest.fn() },
        },
        { provide: PayoutEncryptionService, useValue: payoutEncryption },
        { provide: PayoutAccountService, useValue: payoutAccountService },
        {
          provide: CareSkillService,
          useValue: {
            assertSkillsAllowed: jest.fn().mockResolvedValue(undefined),
          },
        },
        ClockService,
        { provide: DrivingLicenseService, useValue: { assertForKyc: jest.fn(), getState: jest.fn().mockResolvedValue({ verified: false, status: 'none', isExpired: false }) } },
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

  describe('submitKyc — hourlyRate (PYG-536)', () => {
    const user = { id: USER_ID, email: 'x@y.com' } as AuthUser;
    const upsertArg = () => tx.caregiver.upsert.mock.calls[0][0];

    it('ไม่ส่ง hourlyRate (FE รุ่นใหม่) → ส่งผ่าน และไม่เขียน hourlyRate', async () => {
      prisma.caregiver.findUnique.mockResolvedValueOnce(null);

      await service.submitKyc(user, baseKycInput());

      expect(upsertArg().create).not.toHaveProperty('hourlyRate');
      expect(upsertArg().update).not.toHaveProperty('hourlyRate');
    });

    it('ส่ง hourlyRate มา (FE รุ่นเก่า) → ถูกทิ้ง ไม่เขียนลงตาราง', async () => {
      prisma.caregiver.findUnique.mockResolvedValueOnce(null);

      await service.submitKyc(user, baseKycInput({ hourlyRate: 999 }));

      expect(upsertArg().create).not.toHaveProperty('hourlyRate');
      expect(upsertArg().update).not.toHaveProperty('hourlyRate');
    });
    it('resubmit ของผู้ดูแลเดิม (มี rate อยู่แล้ว) → rate เดิมไม่หาย และ edit log ไม่มี hourlyRate', async () => {
      const OLD_RATE = 350;
      prisma.caregiver.findUnique.mockResolvedValueOnce({
        id: CAREGIVER_ID,
        kycStatus: 'rejected',
        resubmitCount: 0,
        caregiverNumber: 'CG-260101-0001',
        fullName: 'สมชาย ใจดี',
        idCardNumber: '1234567890123',
        phone: '0812345678',
        skills: ['bathing'],
        experienceYears: 3,
        hourlyRate: OLD_RATE,
      });
      // upsert ไม่แตะ hourly_rate → DB คืนแถวที่ยังมีค่าเดิม
      tx.caregiver.upsert.mockResolvedValueOnce({ id: CAREGIVER_ID, resubmitCount: 1, hourlyRate: OLD_RATE });

      const result = await service.submitKyc(user, baseKycInput({ hourlyRate: 999 }));

      // ไม่มี key hourlyRate ใน update → Prisma ไม่เขียนคอลัมน์นี้ ค่าเดิมคงอยู่ (ไม่ใช่ set null)
      expect(upsertArg().update).not.toHaveProperty('hourlyRate');
      expect(result.hourlyRate).toBe(OLD_RATE);

      // edit log: ค่าที่ 4 ของ $executeRaw คือ field_changes (JSON)
      const changesJson = tx.$executeRaw.mock.calls[0][4] as string;
      const fields = (JSON.parse(changesJson) as Array<{ field: string }>).map((c) => c.field);
      expect(fields).not.toContain('hourlyRate');
    });
  });

  // ─── PYG-575: วิชาชีพใน KYC (S01-AC1 · E2 · E3 · E4) ─────────────────────
  describe('submitKyc — profession (PYG-575)', () => {
    const user = { id: USER_ID, email: 'x@y.com' } as AuthUser;
    /** argument แรกของ tx.caregiver.upsert (create / update ที่ service ส่งให้ Prisma) */
    const upsertArg = () =>
      (tx.caregiver.upsert.mock.calls[0] as unknown[])[0] as {
        create: Record<string, unknown>;
        update: Record<string, unknown>;
      };

    /** เรียก submitKyc แล้วคืน error ที่โยนออกมา (เทสต้องการดู extensions) */
    async function submitError(input: KycInput): Promise<ProfessionError> {
      try {
        await service.submitKyc(user, input);
      } catch (err) {
        return err as ProfessionError;
      }
      throw new Error('submitKyc ควร throw');
    }

    /**
     * nurse / physiotherapist ต้องมีใบประกอบฯ ตั้งแต่ PYG-587 — ด่านนั้นมีเทสของตัวเองใน kyc-license-gate.spec.ts
     * เทสในกลุ่มนี้ดูแค่การรับและบันทึกวิชาชีพ จึงให้ด่านใบประกอบฯ ผ่านไป
     */
    const skipLicenseGate = () =>
      jest
        .spyOn(service as unknown as { assertLicenseForKyc: () => Promise<void> }, 'assertLicenseForKyc')
        .mockResolvedValue(undefined);

    it.each([
      ['ไม่ส่ง field (client เก่า)', undefined],
      ['null', null],
      ['สตริงว่าง', ''],
      ['มีแต่ช่องว่าง', '   '],
    ])(
      'E3: %s → PROFESSION_REQUIRED และไม่แตะ DB เลย (ไม่เติมค่าเริ่มต้นให้)',
      async (_label, value) => {
        const err = await submitError(
          baseKycInput({ profession: value as string | undefined }),
        );

        expect(err).toBeInstanceOf(ProfessionError);
        expect(err.extensions).toEqual({
          code: 'PROFESSION_REQUIRED',
          allowed: ['general_caregiver', 'nurse', 'physiotherapist'],
        });
        expect(prisma.caregiver.findUnique).not.toHaveBeenCalled();
        expect(prisma.$transaction).not.toHaveBeenCalled();
      },
    );

    it.each(['doctor', 'NURSE', ' nurse', 'nurse_aide'])(
      'E4: ค่านอกรายการ "%s" → PROFESSION_INVALID ก่อนถึง DB',
      async (value) => {
        const err = await submitError(baseKycInput({ profession: value }));

        expect(err.extensions).toMatchObject({
          code: 'PROFESSION_INVALID',
          received: value,
        });
        expect(prisma.$transaction).not.toHaveBeenCalled();
      },
    );

    it('ตรวจวิชาชีพก่อนสถานะ KYC — ผู้ดูแล verified ที่ไม่ส่งค่าก็ได้ PROFESSION_REQUIRED (code เดียวกันเสมอ)', async () => {
      prisma.caregiver.findUnique.mockResolvedValueOnce({
        id: CAREGIVER_ID,
        kycStatus: 'verified',
      });

      const err = await submitError(baseKycInput({ profession: undefined }));

      expect(err.extensions).toMatchObject({ code: 'PROFESSION_REQUIRED' });
    });

    it('S01-AC1: first submit ด้วย nurse → เขียนลงทั้ง create และ update ของ upsert + คืนใน entity', async () => {
      skipLicenseGate();
      prisma.caregiver.findUnique.mockResolvedValueOnce(null);
      tx.caregiver.upsert.mockResolvedValueOnce({
        id: CAREGIVER_ID,
        resubmitCount: 0,
        profession: 'nurse',
        skills: [],
      });

      const result = await service.submitKyc(
        user,
        baseKycInput({ profession: 'nurse' }),
      );

      expect(upsertArg().create.profession).toBe('nurse');
      expect(upsertArg().update.profession).toBe('nurse');
      expect(result.profession).toBe('nurse');
    });

    it('E2: ถูกปฏิเสธแล้วส่งใหม่ เปลี่ยนวิชาชีพได้ทันที + edit log มี profession เดิม → ใหม่', async () => {
      skipLicenseGate();
      prisma.caregiver.findUnique.mockResolvedValueOnce({
        id: CAREGIVER_ID,
        kycStatus: 'rejected',
        resubmitCount: 0,
        caregiverNumber: 'CG-260101-0001',
        fullName: 'สมชาย ใจดี',
        idCardNumber: '1234567890123',
        phone: '0812345678',
        skills: ['elder_care'],
        experienceYears: 3,
        // ผู้ดูแลเดิมหลัง migration (PYG-574 backfill)
        profession: 'general_caregiver',
      });

      await service.submitKyc(
        user,
        baseKycInput({ profession: 'physiotherapist' }),
      );

      // ไม่มีขั้นตรวจแยก — ค่าใหม่ลงตารางในรอบ resubmit นี้เลย (KYC ทั้งชุดรอแอดมินตรวจอยู่แล้ว)
      expect(upsertArg().update.profession).toBe('physiotherapist');

      const [, , , action, changesJson] = tx.$executeRaw.mock.calls[0] as [
        unknown,
        string,
        string,
        string,
        string,
      ];
      expect(action).toBe('resubmit');
      expect(JSON.parse(changesJson)).toContainEqual({
        field: 'profession',
        oldValue: '"general_caregiver"',
        newValue: '"physiotherapist"',
      });
    });

    it('resubmit ด้วยวิชาชีพเดิม → edit log ไม่มี profession (ไม่ได้เปลี่ยน)', async () => {
      prisma.caregiver.findUnique.mockResolvedValueOnce({
        id: CAREGIVER_ID,
        kycStatus: 'rejected',
        resubmitCount: 0,
        caregiverNumber: 'CG-260101-0001',
        profession: 'general_caregiver',
      });

      await service.submitKyc(
        user,
        baseKycInput({ profession: 'general_caregiver' }),
      );

      const changesJson = (
        tx.$executeRaw.mock.calls[0] as unknown[]
      )[4] as string;
      const fields = (JSON.parse(changesJson) as Array<{ field: string }>).map(
        (c) => c.field,
      );
      expect(fields).not.toContain('profession');
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

  describe('getKycStatus - drivingLicense (PYG-597)', () => {
    it('คำนวณสถานะที่จุดเดียว (DrivingLicenseService) ด้วย caregiverId + userId ของ session และประกอบไฟล์/เหตุผลจาก documents', async () => {
      const drivingLicense = (service as unknown as { drivingLicense: { getState: jest.Mock } }).drivingLicense;
      drivingLicense.getState.mockResolvedValue({
        verified: false,
        status: 'rejected',
        documentId: 'dl-1',
        expiresAt: new Date('2027-01-01T16:59:59.999Z'),
        isExpired: false,
      });
      prisma.caregiver.findUnique.mockResolvedValueOnce({
        id: CAREGIVER_ID,
        kycStatus: 'verified',
        kycSubmittedAt: new Date(),
        kycVerifiedAt: new Date(),
      });
      const caregiverService = (service as unknown as { caregiverService: { getOwnDocumentsWithSignedUrls: jest.Mock } }).caregiverService;
      caregiverService.getOwnDocumentsWithSignedUrls.mockResolvedValueOnce([
        {
          id: 'dl-1',
          docType: 'driving_license',
          fileName: 'dl.jpg',
          signedUrl: 'https://signed/dl.jpg',
          reviewStatus: 'rejected',
          rejectionReason: 'รูปไม่ชัด',
        },
      ]);
      prisma.caregiverPayoutAccount.findUnique.mockResolvedValueOnce(null);

      const result = await service.getKycStatus(USER_ID);

      expect(drivingLicense.getState).toHaveBeenCalledWith({ caregiverId: CAREGIVER_ID, userId: USER_ID });
      expect(result.drivingLicense).toEqual({
        verified: false,
        status: 'rejected',
        documentId: 'dl-1',
        fileName: 'dl.jpg',
        signedUrl: 'https://signed/dl.jpg',
        expiresAt: new Date('2027-01-01T16:59:59.999Z'),
        isExpired: false,
        rejectionReason: 'รูปไม่ชัด',
      });
    });

    it('ยังไม่มีแถวผู้ดูแล -> drivingLicense = none (ไม่ throw)', async () => {
      prisma.caregiver.findUnique.mockResolvedValueOnce(null);
      const result = await service.getKycStatus(USER_ID);
      expect(result.drivingLicense).toEqual({ verified: false, status: 'none', isExpired: false });
    });
  });
});
