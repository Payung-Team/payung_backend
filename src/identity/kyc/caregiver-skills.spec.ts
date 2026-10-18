/**
 * ทักษะผู้ดูแลตอนบันทึก — PYG-652
 *
 *  - submitKyc / updateProfile ตรวจ skills กับวิชาชีพของผู้ดูแล (CareSkillService) ก่อนเขียน
 *  - ตรวจไม่ผ่าน → ไม่แตะตารางเลย
 *  - otherSkills: ยื่นครั้งแรกไม่ส่ง = [] · ยื่นซ้ำ/แก้โปรไฟล์ไม่ส่ง = คงค่าเดิม · ส่ง [] = ล้าง
 */
import { Test } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../common/prisma.service';
import { SupabaseService } from '../../common/supabase.service';
import { NotificationService } from '../../notification/notification.service';
import { EmailService } from '../../email/email.service';
import { PayoutEncryptionService } from '../../common/crypto/payout-encryption.service';
import { PayoutAccountService } from '../../payment/payout-account.service';
import { AuthUser } from '../../common/decorators/current-user.decorator';
import { CareSkillService } from '../../care-skill/care-skill.service';
import { ClockService } from '../../common/clock.service';
import { DrivingLicenseService } from './driving-license/driving-license.service';
import {
  CARE_SKILL_ERROR,
  CareSkillError,
} from '../../care-skill/care-skill.errors';
import { CaregiverService } from './caregiver.service';
import { KycService } from './kyc.service';
import { KycInput } from './dto/kyc.input';

const USER_ID = 'user-cg-1';

const row = (overrides: Record<string, unknown> = {}) => ({
  id: 'cg-1',
  userId: USER_ID,
  caregiverNumber: 'CG-261016-0001',
  fullName: 'สมศรี ใจดี',
  idCardNumber: '1234567890123',
  gender: null,
  dateOfBirth: null,
  address: null,
  phone: '0812345678',
  skills: ['bathing'],
  otherSkills: ['ทำอาหาร'],
  experienceYears: 3,
  hourlyRate: null,
  bio: null,
  profession: 'general_caregiver',
  kycStatus: 'verified',
  kycSubmittedAt: null,
  kycVerifiedAt: null,
  isSearchable: true,
  languages: [],
  resubmitCount: 0,
  createdAt: new Date('2026-10-01T00:00:00Z'),
  updatedAt: new Date('2026-10-01T00:00:00Z'),
  ...overrides,
});

const notAllowed = () =>
  new CareSkillError('x', CARE_SKILL_ERROR.SKILL_NOT_ALLOWED_FOR_PROFESSION, {
    skills: ['injection'],
    profession: 'general_caregiver',
  });

describe('ทักษะผู้ดูแลตอนบันทึก (PYG-652)', () => {
  let tx: {
    caregiver: { update: jest.Mock; upsert: jest.Mock };
    kycDocument: { findMany: jest.Mock; updateMany: jest.Mock };
    $executeRaw: jest.Mock;
  };
  let prisma: {
    caregiver: { findUnique: jest.Mock };
    kycDocument: { findMany: jest.Mock };
    $transaction: jest.Mock;
  };
  let careSkill: { assertSkillsAllowed: jest.Mock };
  let caregiverService: CaregiverService;
  let kycService: KycService;

  const updateData = () =>
    (
      tx.caregiver.update.mock.calls[0] as [{ data: Record<string, unknown> }]
    )[0].data;
  const upsertArg = () =>
    (
      tx.caregiver.upsert.mock.calls[0] as [
        { create: Record<string, unknown>; update: Record<string, unknown> },
      ]
    )[0];

  beforeEach(async () => {
    tx = {
      caregiver: {
        update: jest.fn(({ data }: { data: object }) =>
          Promise.resolve({ ...row(), ...data }),
        ),
        upsert: jest.fn(() => Promise.resolve(row({ kycStatus: 'pending' }))),
      },
      kycDocument: {
        findMany: jest.fn().mockResolvedValue([]),
        updateMany: jest.fn(),
      },
      $executeRaw: jest.fn().mockResolvedValue(1),
    };
    prisma = {
      caregiver: { findUnique: jest.fn().mockResolvedValue(row()) },
      kycDocument: { findMany: jest.fn().mockResolvedValue([]) },
      $transaction: jest.fn((cb: (t: typeof tx) => unknown) => cb(tx)),
    };
    careSkill = { assertSkillsAllowed: jest.fn().mockResolvedValue(undefined) };

    const mod = await Test.createTestingModule({
      providers: [
        KycService,
        CaregiverService,
        { provide: PrismaService, useValue: prisma },
        { provide: SupabaseService, useValue: {} },
        { provide: ConfigService, useValue: {} },
        { provide: NotificationService, useValue: { create: jest.fn() } },
        {
          provide: EmailService,
          useValue: {
            sendKycSubmitted: jest.fn(),
            sendKycResubmitted: jest.fn(),
          },
        },
        { provide: PayoutEncryptionService, useValue: {} },
        { provide: PayoutAccountService, useValue: {} },
        { provide: CareSkillService, useValue: careSkill },
        ClockService,
        { provide: DrivingLicenseService, useValue: { assertForKyc: jest.fn() } },
      ],
    }).compile();

    caregiverService = mod.get(CaregiverService);
    kycService = mod.get(KycService);
    jest
      .spyOn(caregiverService, 'generateCaregiverNumber')
      .mockResolvedValue('CG-261016-0002');
    // log ของ notification/email ไม่ใช่เรื่องของเทสต์นี้
    jest
      .spyOn(kycService['logger'], 'error')
      .mockImplementation(() => undefined);
    jest
      .spyOn(kycService['logger'], 'warn')
      .mockImplementation(() => undefined);
  });

  describe('updateProfile', () => {
    it('ส่ง skills มา → ตรวจกับวิชาชีพของผู้ดูแลในตาราง', async () => {
      prisma.caregiver.findUnique.mockResolvedValueOnce(
        row({ profession: 'nurse' }),
      );
      await caregiverService.updateProfile(USER_ID, { skills: ['injection'] });
      expect(careSkill.assertSkillsAllowed).toHaveBeenCalledWith(
        ['injection'],
        'nurse',
      );
      expect(updateData()).toEqual({ skills: ['injection'] });
    });

    it('ตรวจไม่ผ่าน → throw และไม่เขียนตาราง ไม่ลง edit log', async () => {
      careSkill.assertSkillsAllowed.mockRejectedValueOnce(notAllowed());
      await expect(
        caregiverService.updateProfile(USER_ID, { skills: ['injection'] }),
      ).rejects.toBeInstanceOf(CareSkillError);
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('ไม่ส่ง skills → ไม่ตรวจ (แก้ field อื่นได้แม้ทักษะเดิมยังไม่ใช่รหัสกลาง)', async () => {
      await caregiverService.updateProfile(USER_ID, { bio: 'ใหม่' });
      expect(careSkill.assertSkillsAllowed).not.toHaveBeenCalled();
    });

    it('otherSkills: ส่งมา → เขียน + ลง edit log · ส่ง [] → ล้าง · ไม่ส่ง → ไม่แตะ', async () => {
      const result = await caregiverService.updateProfile(USER_ID, {
        otherSkills: ['เป็นเพื่อนคุย'],
      });
      expect(updateData()).toEqual({ otherSkills: ['เป็นเพื่อนคุย'] });
      expect(result.otherSkills).toEqual(['เป็นเพื่อนคุย']);
      expect(tx.$executeRaw).toHaveBeenCalledTimes(1);

      tx.caregiver.update.mockClear();
      await caregiverService.updateProfile(USER_ID, { otherSkills: [] });
      expect(updateData()).toEqual({ otherSkills: [] });

      tx.caregiver.update.mockClear();
      await caregiverService.updateProfile(USER_ID, { bio: 'x' });
      expect(updateData()).not.toHaveProperty('otherSkills');
    });
  });

  describe('submitKyc', () => {
    const user = { id: USER_ID } as AuthUser;
    const input = (overrides: Partial<KycInput> = {}) =>
      ({
        profession: 'general_caregiver', // PYG-575: บังคับส่ง
        fullName: 'สมศรี ใจดี',
        idCardNumber: '1234567890123',
        phone: '0812345678',
        skills: ['bathing', 'dementia_care'],
        experienceYears: 3,
        documentIds: [],
        ...overrides,
      }) as KycInput;

    beforeEach(() => {
      // nurse / physiotherapist ต้องมีใบประกอบฯ ตั้งแต่ PYG-587 — ด่านนั้นมีเทสของตัวเอง (kyc-license-gate.spec)
      jest
        .spyOn(kycService as unknown as { assertLicenseForKyc: () => Promise<void> }, 'assertLicenseForKyc')
        .mockResolvedValue(undefined);
    });

    it('ยื่นครั้งแรก (ยังไม่มีแถว) → ตรวจด้วยวิชาชีพที่ส่งมา · otherSkills = []', async () => {
      prisma.caregiver.findUnique.mockResolvedValueOnce(null);
      await kycService.submitKyc(user, input());
      expect(careSkill.assertSkillsAllowed).toHaveBeenCalledWith(
        ['bathing', 'dementia_care'],
        'general_caregiver',
      );
      expect(upsertArg().create.otherSkills).toEqual([]);
    });

    it('ยื่นครั้งแรกเป็น nurse (ยังไม่มีแถว) → ตรวจด้วย nurse ไม่ใช่ค่า default ของคอลัมน์', async () => {
      prisma.caregiver.findUnique.mockResolvedValueOnce(null);
      await kycService.submitKyc(user, input({ profession: 'nurse', skills: ['injection'] }));
      expect(careSkill.assertSkillsAllowed).toHaveBeenCalledWith(['injection'], 'nurse');
    });

    it('ยื่นซ้ำ → ตรวจด้วยวิชาชีพที่ส่งมาในรอบนี้ · ไม่ส่ง otherSkills = คงค่าเดิม', async () => {
      prisma.caregiver.findUnique.mockResolvedValueOnce(
        row({ kycStatus: 'rejected', profession: 'physiotherapist' }),
      );
      await kycService.submitKyc(
        user,
        input({ profession: 'physiotherapist', skills: ['physiotherapy'] }),
      );
      expect(careSkill.assertSkillsAllowed).toHaveBeenCalledWith(
        ['physiotherapy'],
        'physiotherapist',
      );
      expect(upsertArg().update).not.toHaveProperty('otherSkills');
    });

    it('ยื่นซ้ำแล้วเปลี่ยนจาก nurse เป็น general_caregiver → ตรวจด้วย general_caregiver (ทักษะเฉพาะพยาบาลถูกปฏิเสธ)', async () => {
      prisma.caregiver.findUnique.mockResolvedValueOnce(
        row({ kycStatus: 'rejected', profession: 'nurse' }),
      );
      await kycService.submitKyc(user, input({ skills: ['injection'] }));
      expect(careSkill.assertSkillsAllowed).toHaveBeenCalledWith(['injection'], 'general_caregiver');
    });

    it('ส่ง otherSkills มา → เขียนทั้งตอนสร้างและตอนยื่นซ้ำ', async () => {
      prisma.caregiver.findUnique.mockResolvedValueOnce(
        row({ kycStatus: 'rejected' }),
      );
      await kycService.submitKyc(
        user,
        input({ otherSkills: ['ทำอาหาร', 'เป็นเพื่อนคุย'] }),
      );
      expect(upsertArg().create.otherSkills).toEqual([
        'ทำอาหาร',
        'เป็นเพื่อนคุย',
      ]);
      expect(upsertArg().update.otherSkills).toEqual([
        'ทำอาหาร',
        'เป็นเพื่อนคุย',
      ]);
    });

    it('ตรวจไม่ผ่าน → throw ก่อนแตะตาราง', async () => {
      prisma.caregiver.findUnique.mockResolvedValueOnce(null);
      careSkill.assertSkillsAllowed.mockRejectedValueOnce(notAllowed());
      await expect(
        kycService.submitKyc(user, input({ skills: ['injection'] })),
      ).rejects.toBeInstanceOf(CareSkillError);
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });
  });
});
