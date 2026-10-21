/**
 * KycService.submitKyc — ตรวจใบประกอบวิชาชีพตามวิชาชีพ (PYG-587: AC2, E2, E3, E4, E9, E10)
 */
import { Test } from '@nestjs/testing';
import { KycService } from './kyc.service';
import { DrivingLicenseService } from './driving-license/driving-license.service';
import { PrismaService } from '../../common/prisma.service';
import { ClockService } from '../../common/clock.service';
import { CaregiverService } from './caregiver.service';
import { NotificationService } from '../../notification/notification.service';
import { EmailService } from '../../email/email.service';
import { PayoutEncryptionService } from '../../common/crypto/payout-encryption.service';
import { PayoutAccountService } from '../../payment/payout-account.service';
import { AuthUser } from '../../common/decorators/current-user.decorator';
import { KycInput } from './dto/kyc.input';
import { CareSkillService } from '../../care-skill/care-skill.service';

const NOW = new Date('2026-10-18T03:00:00Z'); // 10:00 ไทย
const USER = { id: 'user-1' } as AuthUser;
const DOC_ID = '11111111-1111-4111-8111-111111111111';
const FUTURE = new Date('2027-12-31T16:59:59.999Z');

/** วิชาชีพที่ส่งมาใน input — PYG-575: submitKyc ตรวจใบประกอบฯ ตามค่านี้ (ไม่ใช่ค่าเดิมในแถว) */
let submittedProfession = 'general_caregiver';

const input = (documentIds: string[] = [DOC_ID]) =>
  ({
    profession: submittedProfession,
    fullName: 'สมชาย ใจดี',
    idCardNumber: '1234567890123',
    phone: '0812345678',
    skills: ['elder_care'],
    experienceYears: 3,
    documentIds,
  }) as KycInput;

function licenseDoc(over: Record<string, unknown> = {}) {
  return {
    id: DOC_ID,
    licenseNumber: 'N-123',
    expiresAt: FUTURE,
    reviewStatus: 'pending',
    uploadedAt: NOW,
    ...over,
  };
}

describe('KycService.submitKyc — ใบประกอบวิชาชีพ (PYG-587)', () => {
  let service: KycService;
  let caregiverFindUnique: jest.Mock;
  let docFindMany: jest.Mock;
  let tx: any;

  /** findMany ของ kycDocument ถูกเรียกหลายที่ — แยกด้วย where.documentType */
  function setDocs(licenseDocs: unknown[]) {
    docFindMany.mockImplementation(({ where }: any) => {
      if (where?.documentType === 'professional_license') return Promise.resolve(licenseDocs);
      return Promise.resolve([{ id: DOC_ID }]);
    });
  }

  beforeEach(async () => {
    submittedProfession = 'general_caregiver';
    tx = {
      caregiver: {
        upsert: jest.fn().mockResolvedValue({ id: 'cg-1', userId: USER.id, resubmitCount: 0 }),
      },
      kycDocument: {
        findMany: jest.fn().mockResolvedValue([]),
        updateMany: jest.fn(),
      },
      $executeRaw: jest.fn(),
    };
    caregiverFindUnique = jest.fn();
    docFindMany = jest.fn();
    setDocs([]);
    const prisma = {
      caregiver: { findUnique: caregiverFindUnique },
      kycDocument: { findMany: docFindMany },
      $transaction: jest.fn((cb: (t: unknown) => unknown) => cb(tx)),
    };

    const mod = await Test.createTestingModule({
      providers: [
        KycService,
        { provide: PrismaService, useValue: prisma },
        {
          provide: CaregiverService,
          useValue: { generateCaregiverNumber: jest.fn().mockResolvedValue('CG-1') },
        },
        { provide: NotificationService, useValue: { create: jest.fn() } },
        {
          provide: EmailService,
          useValue: { sendKycSubmitted: jest.fn(), sendKycResubmitted: jest.fn() },
        },
        { provide: PayoutEncryptionService, useValue: {} },
        { provide: PayoutAccountService, useValue: {} },
        { provide: ClockService, useValue: { now: () => NOW } },
        // PYG-652: ด่านทักษะมีเทสของตัวเอง (caregiver-skills.spec) — ที่นี่ให้ผ่าน
        { provide: CareSkillService, useValue: { assertSkillsAllowed: jest.fn().mockResolvedValue(undefined) } },
        { provide: DrivingLicenseService, useValue: { assertForKyc: jest.fn(), getState: jest.fn().mockResolvedValue({ verified: false, status: 'none', isExpired: false }) } },
      ],
    }).compile();
    service = mod.get(KycService);
  });

  const asProfession = (profession: string) => {
    submittedProfession = profession;
    caregiverFindUnique.mockResolvedValue({ kycStatus: 'none', profession, resubmitCount: 0 });
  };

  describe.each(['nurse', 'physiotherapist'])('%s', (profession) => {
    beforeEach(() => asProfession(profession));

    it('E10: client เก่าไม่ส่งเอกสารใบประกอบฯ เลย → LICENSE_FILE_REQUIRED (422) ไม่ปล่อยผ่าน', async () => {
      await expect(service.submitKyc(USER, input([]))).rejects.toMatchObject({
        extensions: { code: 'LICENSE_FILE_REQUIRED', statusCode: 422 },
      });
      expect(tx.caregiver.upsert).not.toHaveBeenCalled();
    });

    it('ส่งเอกสารอื่น แต่ไม่มีใบประกอบฯ → LICENSE_FILE_REQUIRED', async () => {
      setDocs([]);
      await expect(service.submitKyc(USER, input())).rejects.toMatchObject({
        extensions: { code: 'LICENSE_FILE_REQUIRED' },
      });
    });

    it('มีไฟล์แต่ไม่มีเลข → LICENSE_NUMBER_REQUIRED', async () => {
      setDocs([licenseDoc({ licenseNumber: null })]);
      await expect(service.submitKyc(USER, input())).rejects.toMatchObject({
        extensions: { code: 'LICENSE_NUMBER_REQUIRED' },
      });
    });

    it('มีไฟล์แต่ไม่มีวันหมดอายุ → LICENSE_EXPIRY_REQUIRED', async () => {
      setDocs([licenseDoc({ expiresAt: null })]);
      await expect(service.submitKyc(USER, input())).rejects.toMatchObject({
        extensions: { code: 'LICENSE_EXPIRY_REQUIRED' },
      });
    });

    it('ขาดทั้งเลขและวันหมดอายุ → ตอบครบทุกช่องใน extensions.codes', async () => {
      setDocs([licenseDoc({ licenseNumber: '  ', expiresAt: null })]);
      await expect(service.submitKyc(USER, input())).rejects.toMatchObject({
        extensions: {
          code: 'LICENSE_NUMBER_REQUIRED',
          codes: ['LICENSE_NUMBER_REQUIRED', 'LICENSE_EXPIRY_REQUIRED'],
        },
      });
    });

    it('E3: ใบที่อัปโหลดไว้แล้วถึงวันนี้ (เวลาไทย) → LICENSE_EXPIRY_NOT_FUTURE ตอนส่ง', async () => {
      setDocs([licenseDoc({ expiresAt: new Date('2026-10-18T16:59:59.999Z') })]);
      await expect(service.submitKyc(USER, input())).rejects.toMatchObject({
        extensions: { code: 'LICENSE_EXPIRY_NOT_FUTURE' },
      });
    });

    it('E4: ใบหมดอายุย้อนหลัง → LICENSE_EXPIRY_NOT_FUTURE', async () => {
      setDocs([licenseDoc({ expiresAt: new Date('2026-09-01T16:59:59.999Z') })]);
      await expect(service.submitKyc(USER, input())).rejects.toMatchObject({
        extensions: { code: 'LICENSE_EXPIRY_NOT_FUTURE' },
      });
    });

    it('E6: ใบที่ถูกปฏิเสธแล้วส่งซ้ำไม่ได้ → LICENSE_FILE_REQUIRED (ต้องอัปโหลดใบใหม่)', async () => {
      setDocs([licenseDoc({ reviewStatus: 'rejected' })]);
      await expect(service.submitKyc(USER, input())).rejects.toMatchObject({
        extensions: { code: 'LICENSE_FILE_REQUIRED' },
      });
    });

    it('ใบที่ expired แล้วส่งซ้ำไม่ได้ → LICENSE_FILE_REQUIRED', async () => {
      setDocs([licenseDoc({ reviewStatus: 'expired' })]);
      await expect(service.submitKyc(USER, input())).rejects.toMatchObject({
        extensions: { code: 'LICENSE_FILE_REQUIRED' },
      });
    });

    it('ครบ + วันหมดอายุในอนาคต → ส่ง KYC ได้', async () => {
      setDocs([licenseDoc()]);
      await expect(service.submitKyc(USER, input())).resolves.toBeDefined();
      expect(tx.caregiver.upsert).toHaveBeenCalled();
    });

    it('ตรวจเอกสารเฉพาะของผู้ใช้ที่ล็อกอิน (userId จาก session ไม่ใช่ input)', async () => {
      setDocs([licenseDoc()]);
      await service.submitKyc(USER, input());
      const licenseCall = docFindMany.mock.calls.find(
        ([a]: any[]) => a.where?.documentType === 'professional_license',
      );
      expect(licenseCall?.[0].where.userId).toBe('user-1');
    });
  });

  it('E2: เปลี่ยนวิชาชีพเป็นนักกายภาพ — ใบเดิมที่ไม่ได้ส่งมาในรอบนี้ไม่นับ → ต้องมีใบใหม่', async () => {
    asProfession('physiotherapist');
    // ไม่มีใบประกอบฯ ใน documentIds ของรอบนี้ (ใบพยาบาลเดิมอยู่ในระบบ แต่ไม่ได้ส่งมา)
    setDocs([]);
    await expect(service.submitKyc(USER, input())).rejects.toMatchObject({
      extensions: { code: 'LICENSE_FILE_REQUIRED' },
    });
  });

  // PYG-670: ยื่นซ้ำโดยสลับพยาบาล ↔ นักกายภาพฯ — ใบที่ผูกกับรอบก่อน (caregiver_id = แถวเดิม) เป็นของวิชาชีพเดิม
  describe('E2 · ยื่นซ้ำสลับวิชาชีพที่ต้องมีใบ (PYG-670)', () => {
    const resubmitAs = (from: string, to: string) => {
      caregiverFindUnique.mockResolvedValue({
        id: 'cg-1',
        kycStatus: 'rejected',
        profession: from,
        resubmitCount: 0,
      });
      submittedProfession = to;
    };

    it.each([
      ['nurse', 'physiotherapist'],
      ['physiotherapist', 'nurse'],
    ])(
      '%s → %s ด้วยใบที่ผูกกับรอบก่อน (client ส่ง id เดิมกลับมา) → LICENSE_FILE_REQUIRED ไม่เขียน DB',
      async (from, to) => {
        resubmitAs(from, to);
        setDocs([licenseDoc({ caregiverId: 'cg-1' })]);
        await expect(service.submitKyc(USER, input())).rejects.toMatchObject({
          extensions: { code: 'LICENSE_FILE_REQUIRED', statusCode: 422 },
        });
        expect(tx.caregiver.upsert).not.toHaveBeenCalled();
      },
    );

    it('nurse → physiotherapist ด้วยใบที่อัปโหลดใหม่ (ยังไม่ผูก) → ส่งได้', async () => {
      resubmitAs('nurse', 'physiotherapist');
      setDocs([licenseDoc({ caregiverId: null })]);
      await expect(service.submitKyc(USER, input())).resolves.toBeDefined();
    });

    it('ส่งทั้งใบเดิมและใบใหม่มาพร้อมกัน → ใช้ใบใหม่ ส่งได้', async () => {
      resubmitAs('nurse', 'physiotherapist');
      setDocs([
        licenseDoc({ id: 'old', caregiverId: 'cg-1' }),
        licenseDoc({ id: 'new', caregiverId: null }),
      ]);
      await expect(service.submitKyc(USER, input())).resolves.toBeDefined();
    });

    it('วิชาชีพเดิม (nurse → nurse) ใช้ใบที่ผูกกับรอบก่อนได้ตามเดิม', async () => {
      resubmitAs('nurse', 'nurse');
      setDocs([licenseDoc({ caregiverId: 'cg-1' })]);
      await expect(service.submitKyc(USER, input())).resolves.toBeDefined();
    });

    it('general_caregiver → nurse ใช้ใบที่แนบไว้กับรอบก่อนได้ (รอบก่อนไม่ได้ใช้ใบเป็นหลักฐานวิชาชีพใด · E1)', async () => {
      resubmitAs('general_caregiver', 'nurse');
      setDocs([licenseDoc({ caregiverId: 'cg-1' })]);
      await expect(service.submitKyc(USER, input())).resolves.toBeDefined();
    });
  });

  describe('general_caregiver', () => {
    it('ไม่ตรวจใบประกอบฯ — ส่งได้โดยไม่มีใบ', async () => {
      asProfession('general_caregiver');
      await expect(service.submitKyc(USER, input([]))).resolves.toBeDefined();
    });

    it('E9: แนบใบประกอบฯ มาด้วยก็ไม่ถูกบังคับ/ไม่ถูกปฏิเสธ (แม้ข้อมูลไม่ครบ) · ไม่ query ใบประกอบฯ', async () => {
      asProfession('general_caregiver');
      setDocs([licenseDoc({ licenseNumber: null, expiresAt: null })]);
      await expect(service.submitKyc(USER, input())).resolves.toBeDefined();
      const licenseQueried = docFindMany.mock.calls.some(
        ([a]: any[]) => a.where?.documentType === 'professional_license',
      );
      expect(licenseQueried).toBe(false);
    });

    it('ผู้ดูแลใหม่ที่ยังไม่มีแถว caregivers ส่ง general_caregiver → ไม่ตรวจใบประกอบฯ', async () => {
      caregiverFindUnique.mockResolvedValue(null);
      await expect(service.submitKyc(USER, input([]))).resolves.toBeDefined();
    });
  });

  // PYG-575 × PYG-587: วิชาชีพมาจาก input ของรอบนี้ — ต้องตรวจตามค่าที่ส่ง ไม่ใช่ค่าเดิมในแถว
  describe('ตรวจตามวิชาชีพที่ส่งมา ไม่ใช่ค่าเดิมในแถว', () => {
    it.each(['nurse', 'physiotherapist'])(
      'ผู้ดูแลใหม่ (ยังไม่มีแถว) ส่ง %s โดยไม่มีใบประกอบฯ → LICENSE_FILE_REQUIRED',
      async (profession) => {
        caregiverFindUnique.mockResolvedValue(null);
        submittedProfession = profession;
        await expect(service.submitKyc(USER, input([]))).rejects.toMatchObject({
          extensions: { code: 'LICENSE_FILE_REQUIRED', statusCode: 422 },
        });
        expect(tx.caregiver.upsert).not.toHaveBeenCalled();
      },
    );

    it('ยื่นซ้ำหลังถูกปฏิเสธ แถวเดิมเป็น general_caregiver แต่ส่ง nurse → ต้องตรวจใบประกอบฯ', async () => {
      caregiverFindUnique.mockResolvedValue({ kycStatus: 'rejected', profession: 'general_caregiver', resubmitCount: 0 });
      submittedProfession = 'nurse';
      await expect(service.submitKyc(USER, input([]))).rejects.toMatchObject({
        extensions: { code: 'LICENSE_FILE_REQUIRED' },
      });
      expect(tx.caregiver.upsert).not.toHaveBeenCalled();
    });

    it('แถวเดิมเป็น nurse แต่ส่ง general_caregiver → ไม่ตรวจใบประกอบฯ', async () => {
      caregiverFindUnique.mockResolvedValue({ kycStatus: 'rejected', profession: 'nurse', resubmitCount: 0 });
      submittedProfession = 'general_caregiver';
      await expect(service.submitKyc(USER, input([]))).resolves.toBeDefined();
      const licenseQueried = docFindMany.mock.calls.some(
        ([a]: any[]) => a.where?.documentType === 'professional_license',
      );
      expect(licenseQueried).toBe(false);
    });
  });

  describe('ใบขับขี่ตอนส่ง KYC (PYG-597)', () => {
    let drivingAssert: jest.Mock;
    beforeEach(() => {
      // provider ถูกสร้างใน beforeEach หลัก - ดึง mock ออกมาจาก service ผ่าน property
      drivingAssert = (service as unknown as { drivingLicense: { assertForKyc: jest.Mock } }).drivingLicense.assertForKyc;
      drivingAssert.mockReset();
      caregiverFindUnique.mockResolvedValue({ kycStatus: 'none', profession: 'general_caregiver', resubmitCount: 0 });
    });

    it('ส่ง selfDriveTransport + documentIds + userId จาก session ให้ตัวตรวจ', async () => {
      await service.submitKyc(USER, { ...input([DOC_ID]), selfDriveTransport: true } as KycInput);
      expect(drivingAssert).toHaveBeenCalledWith('user-1', true, [DOC_ID]);
    });

    it('ตัวตรวจไม่ผ่าน -> ปฏิเสธและไม่เขียนฐานข้อมูล', async () => {
      drivingAssert.mockRejectedValue(Object.assign(new Error('x'), { extensions: { code: 'DRIVING_LICENSE_REQUIRED' } }));
      await expect(
        service.submitKyc(USER, { ...input([]), selfDriveTransport: true } as KycInput),
      ).rejects.toMatchObject({ extensions: { code: 'DRIVING_LICENSE_REQUIRED' } });
      expect(tx.caregiver.upsert).not.toHaveBeenCalled();
    });

    it('E10: client เก่าไม่ส่ง selfDriveTransport -> ส่ง undefined ให้ตัวตรวจ (ไม่ใส่ค่าเริ่มต้นเอง)', async () => {
      await service.submitKyc(USER, input([]));
      expect(drivingAssert).toHaveBeenCalledWith('user-1', undefined, []);
    });
  });
});
