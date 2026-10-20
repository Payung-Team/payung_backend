/**
 * KycService — transportMode (PYG-661): ส่ง KYC (map input → ตรวจ + เก็บ), kycStatus, updateTransportMode (E1/E2)
 */
import { Test } from '@nestjs/testing';
import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { KycService } from './kyc.service';
import { DrivingLicenseService } from './driving-license/driving-license.service';
import { TransportMode } from './driving-license/transport-mode';
import { PrismaService } from '../../common/prisma.service';
import { ClockService } from '../../common/clock.service';
import { CaregiverService } from './caregiver.service';
import { NotificationService } from '../../notification/notification.service';
import { EmailService } from '../../email/email.service';
import { PayoutEncryptionService } from '../../common/crypto/payout-encryption.service';
import { PayoutAccountService } from '../../payment/payout-account.service';
import { CareSkillService } from '../../care-skill/care-skill.service';
import { AuthUser } from '../../common/decorators/current-user.decorator';
import { KycInput } from './dto/kyc.input';

const USER = { id: 'user-1' } as AuthUser;
const NOW = new Date('2026-10-18T03:00:00Z');

const input = (over: Record<string, unknown> = {}) =>
  ({
    fullName: 'สมชาย ใจดี',
    idCardNumber: '1234567890123',
    phone: '0812345678',
    skills: ['elder_care'],
    experienceYears: 3,
    documentIds: [],
    profession: 'general_caregiver',
    ...over,
  }) as KycInput;

describe('KycService — transportMode (PYG-661)', () => {
  let service: KycService;
  let prisma: any;
  let tx: any;
  let assertForKyc: jest.Mock;
  let getState: jest.Mock;

  beforeEach(async () => {
    tx = {
      caregiver: { upsert: jest.fn().mockResolvedValue({ id: 'cg-1', userId: USER.id, resubmitCount: 0 }) },
      kycDocument: { findMany: jest.fn().mockResolvedValue([]), updateMany: jest.fn() },
      $executeRaw: jest.fn(),
    };
    prisma = {
      caregiver: { findUnique: jest.fn().mockResolvedValue({ kycStatus: 'none', profession: 'general_caregiver', resubmitCount: 0 }), update: jest.fn() },
      kycDocument: { findMany: jest.fn().mockResolvedValue([]) },
      caregiverPayoutAccount: { findUnique: jest.fn().mockResolvedValue(null) },
      $transaction: jest.fn((cb: (t: unknown) => unknown) => cb(tx)),
    };
    assertForKyc = jest.fn();
    getState = jest.fn().mockResolvedValue({ verified: false, status: 'none', isExpired: false });

    const mod = await Test.createTestingModule({
      providers: [
        KycService,
        { provide: PrismaService, useValue: prisma },
        {
          provide: CaregiverService,
          useValue: {
            generateCaregiverNumber: jest.fn().mockResolvedValue('CG-1'),
            getOwnDocumentsWithSignedUrls: jest.fn().mockResolvedValue([]),
          },
        },
        { provide: NotificationService, useValue: { create: jest.fn() } },
        { provide: EmailService, useValue: { sendKycSubmitted: jest.fn(), sendKycResubmitted: jest.fn() } },
        { provide: PayoutEncryptionService, useValue: {} },
        { provide: PayoutAccountService, useValue: {} },
        { provide: ClockService, useValue: { now: () => NOW } },
        { provide: DrivingLicenseService, useValue: { assertForKyc, getState } },
        { provide: CareSkillService, useValue: { validateSkillCodes: jest.fn().mockResolvedValue(undefined), assertSkillsAllowed: jest.fn() } },
      ],
    }).compile();
    service = mod.get(KycService);
    jest.spyOn(service['logger'], 'log').mockImplementation();
  });

  const upsertData = (which: 'create' | 'update') => tx.caregiver.upsert.mock.calls[0][0][which];

  describe('map input ทั้ง 3 ทาง → ตรวจ + เก็บ', () => {
    it.each([
      [TransportMode.SELF_DRIVE, true, 'self_drive'],
      [TransportMode.HIRED_RIDE, false, 'hired_ride'],
      [TransportMode.NONE, false, 'none'],
    ])('ทาง 1: transportMode=%s → assertForKyc(%s) และเก็บ %s (ทั้ง create และ update)', async (mode, selfDrive, stored) => {
      await service.submitKyc(USER, input({ transportMode: mode }));
      expect(assertForKyc).toHaveBeenCalledWith('user-1', selfDrive, []);
      expect(upsertData('create').transportMode).toBe(stored);
      expect(upsertData('update').transportMode).toBe(stored);
    });

    it('ทาง 2: ไม่ส่ง transportMode, selfDriveTransport=true → ตรวจใบ + เก็บ self_drive', async () => {
      await service.submitKyc(USER, input({ selfDriveTransport: true }));
      expect(assertForKyc).toHaveBeenCalledWith('user-1', true, []);
      expect(upsertData('update').transportMode).toBe('self_drive');
    });

    it('ทาง 2: selfDriveTransport=false → ไม่ตรวจใบ และ "ไม่เขียนค่า" (คงค่าเดิม/NULL · E10)', async () => {
      await service.submitKyc(USER, input({ selfDriveTransport: false }));
      expect(assertForKyc).toHaveBeenCalledWith('user-1', false, []);
      expect(upsertData('create')).not.toHaveProperty('transportMode');
      expect(upsertData('update')).not.toHaveProperty('transportMode');
    });

    it('ทาง 3: ไม่ส่งสักตัว (client เก่า) → ไม่เขียนค่า ไม่ตีความเป็น none', async () => {
      await service.submitKyc(USER, input());
      expect(assertForKyc).toHaveBeenCalledWith('user-1', undefined, []);
      expect(upsertData('create')).not.toHaveProperty('transportMode');
      expect(upsertData('update')).not.toHaveProperty('transportMode');
    });
  });

  it('input ขัดกัน → 422 TRANSPORT_MODE_CONFLICT ก่อนตรวจใบ/เขียนฐาน', async () => {
    await expect(
      service.submitKyc(USER, input({ transportMode: TransportMode.NONE, selfDriveTransport: true })),
    ).rejects.toMatchObject({ extensions: { code: 'TRANSPORT_MODE_CONFLICT', statusCode: 422 } });
    expect(assertForKyc).not.toHaveBeenCalled();
    expect(tx.caregiver.upsert).not.toHaveBeenCalled();
  });

  it('SELF_DRIVE แต่ไม่มีใบ → ตัวตรวจโยน error และไม่เขียนค่า', async () => {
    assertForKyc.mockRejectedValue(Object.assign(new Error('x'), { extensions: { code: 'DRIVING_LICENSE_REQUIRED' } }));
    await expect(service.submitKyc(USER, input({ transportMode: TransportMode.SELF_DRIVE }))).rejects.toMatchObject({
      extensions: { code: 'DRIVING_LICENSE_REQUIRED' },
    });
    expect(tx.caregiver.upsert).not.toHaveBeenCalled();
  });

  describe('kycStatus.transportMode', () => {
    const status = async (value: string | null) => {
      prisma.caregiver.findUnique.mockResolvedValueOnce({
        id: 'cg-1',
        kycStatus: 'verified',
        profession: 'general_caregiver',
        transportMode: value,
        kycSubmittedAt: NOW,
        kycVerifiedAt: NOW,
      });
      return service.getKycStatus('user-1');
    };

    it.each([
      ['self_drive', TransportMode.SELF_DRIVE],
      ['hired_ride', TransportMode.HIRED_RIDE],
      ['none', TransportMode.NONE],
    ])('คืน %s ให้ FE เติมค่าเดิมตอนยื่นซ้ำ', async (stored, expected) => {
      expect((await status(stored)).transportMode).toBe(expected);
    });

    it('NULL (ยังไม่เคยตอบ) → null ไม่ใช่ NONE', async () => {
      expect((await status(null)).transportMode).toBeNull();
    });
  });

  describe('updateTransportMode (E1/E2)', () => {
    it.each([[TransportMode.SELF_DRIVE], [TransportMode.HIRED_RIDE], [TransportMode.NONE]])(
      'KYC ผ่านแล้ว → เขียน %s โดยไม่บังคับ/ไม่ตรวจใบขับขี่ และไม่แตะ kycStatus',
      async (mode) => {
        prisma.caregiver.findUnique.mockResolvedValue({ id: 'cg-1', kycStatus: 'verified' });
        await expect(service.updateTransportMode('user-1', mode)).resolves.toBe(mode);
        expect(prisma.caregiver.update).toHaveBeenCalledWith({
          where: { id: 'cg-1' },
          data: { transportMode: mode },
        });
        expect(assertForKyc).not.toHaveBeenCalled();
      },
    );

    it('หา caregiver จาก userId ของ session เท่านั้น (ไม่รับ id ที่ส่งมา)', async () => {
      prisma.caregiver.findUnique.mockResolvedValue({ id: 'cg-1', kycStatus: 'verified' });
      await service.updateTransportMode('user-1', TransportMode.NONE);
      expect(prisma.caregiver.findUnique).toHaveBeenCalledWith(expect.objectContaining({ where: { userId: 'user-1' } }));
    });

    it.each([['none'], ['pending'], ['rejected']])('KYC ยังไม่ผ่าน (%s) → Forbidden ไม่เขียน', async (kycStatus) => {
      prisma.caregiver.findUnique.mockResolvedValue({ id: 'cg-1', kycStatus });
      await expect(service.updateTransportMode('user-1', TransportMode.NONE)).rejects.toBeInstanceOf(ForbiddenException);
      expect(prisma.caregiver.update).not.toHaveBeenCalled();
    });

    it('ไม่มีแถวผู้ดูแล → NotFound', async () => {
      prisma.caregiver.findUnique.mockResolvedValue(null);
      await expect(service.updateTransportMode('user-1', TransportMode.NONE)).rejects.toBeInstanceOf(NotFoundException);
    });
  });
});
