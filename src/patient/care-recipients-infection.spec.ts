/**
 * โรคติดเชื้อในโปรไฟล์ผู้สูงอายุฝั่งญาติ (PYG-619: S10-AC1, AC5, R2, R3, R7, R8, E8)
 */
import { ForbiddenException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { CareRecipientsService } from './care-recipients.service';
import { PATIENT_PROFILE_SELECT, toPatientProfile } from './patient-profile.mapper';
import { PrismaService } from '../common/prisma.service';
import { ClockService } from '../common/clock.service';

const PATIENT_ID = 'patient-111';
const OTHER_PATIENT = 'patient-999';
const RECIPIENT_ID = 'r1111111-1111-1111-1111-111111111111';
const NOW = new Date('2026-10-18T03:00:00.000Z');

function row(over: Record<string, unknown> = {}) {
  return {
    id: RECIPIENT_ID,
    name: 'คุณย่า',
    nickname: null,
    patientId: PATIENT_ID,
    is_self: false,
    date_of_birth: null,
    gender: null,
    weight_kg: null,
    height_cm: null,
    mobility_level: null,
    medical_conditions: [],
    current_medications: null,
    allergies: null,
    blood_type: null,
    care_notes: null,
    preferred_hospital: null,
    has_infectious_disease: null,
    ...over,
  };
}

const owned = (value: boolean | null) => ({
  patientId: PATIENT_ID,
  is_deleted: false,
  familyGroupId: null,
  has_infectious_disease: value,
});

describe('CareRecipientsService — โรคติดเชื้อ (PYG-619)', () => {
  let service: CareRecipientsService;
  let prisma: any;

  beforeEach(async () => {
    prisma = {
      careRecipient: {
        findMany: jest.fn(),
        create: jest.fn(),
        findUnique: jest.fn(),
        update: jest.fn().mockResolvedValue(row({ has_infectious_disease: true })),
      },
      familyGroupActivity: { create: jest.fn() },
      $transaction: jest.fn((fn: (tx: unknown) => unknown) => fn(prisma)),
    };
    const mod = await Test.createTestingModule({
      providers: [
        CareRecipientsService,
        { provide: PrismaService, useValue: prisma },
        { provide: ClockService, useValue: { now: () => NOW } },
      ],
    }).compile();
    service = mod.get(CareRecipientsService);
  });

  describe('อ่าน (เฉพาะญาติเจ้าของ)', () => {
    it('ยังไม่ได้ระบุ -> null (ไม่ใช่ false)', async () => {
      prisma.careRecipient.findMany.mockResolvedValue([row()]);
      expect((await service.list(PATIENT_ID))[0].hasInfectiousDisease).toBeNull();
    });

    it.each([[true], [false]])('คืนค่าที่ญาติระบุ (%s)', async (v) => {
      prisma.careRecipient.findMany.mockResolvedValue([row({ has_infectious_disease: v })]);
      expect((await service.list(PATIENT_ID))[0].hasInfectiousDisease).toBe(v);
    });

    it('กรองด้วย patientId ของผู้ใช้ที่ล็อกอิน และ select คอลัมน์นี้เฉพาะเส้นนี้', async () => {
      prisma.careRecipient.findMany.mockResolvedValue([]);
      await service.list(PATIENT_ID);
      const args = prisma.careRecipient.findMany.mock.calls[0][0];
      expect(args.where.patientId).toBe(PATIENT_ID);
      expect(args.select.has_infectious_disease).toBe(true);
    });

    it('ไม่อยู่ใน details (ซึ่งใช้ร่วมกับ snapshot ตอนจอง / กลุ่มครอบครัว / onboarding)', async () => {
      prisma.careRecipient.findMany.mockResolvedValue([row({ has_infectious_disease: true, allergies: 'ถั่ว' })]);
      const [r] = await service.list(PATIENT_ID);
      expect(JSON.stringify(r.details)).not.toMatch(/infect/i);
    });
  });

  describe('ไม่พาคอลัมน์ออกทางที่ใช้ร่วม (E8)', () => {
    it('PATIENT_PROFILE_SELECT (ใช้ใน family-group) ไม่มีคอลัมน์โรคติดเชื้อ', () => {
      expect(Object.keys(PATIENT_PROFILE_SELECT).join(',')).not.toMatch(/infect/i);
    });

    it('toPatientProfile ไม่คืนค่าโรคติดเชื้อแม้แถวมีคอลัมน์นี้', () => {
      const profile = toPatientProfile({ ...row({ has_infectious_disease: true, allergies: 'ถั่ว' }) } as never);
      expect(JSON.stringify(profile)).not.toMatch(/infect/i);
    });
  });

  describe('update', () => {
    it('บันทึกค่า + infectious_disease_updated_at เมื่อรับทราบข้อความแจ้ง', async () => {
      prisma.careRecipient.findUnique.mockResolvedValue(owned(null));
      const res = await service.update(PATIENT_ID, RECIPIENT_ID, {
        hasInfectiousDisease: true,
        disclosureNoticeAccepted: true,
      });
      expect(prisma.careRecipient.update.mock.calls[0][0].data).toMatchObject({
        has_infectious_disease: true,
        infectious_disease_updated_at: NOW,
      });
      expect(res.hasInfectiousDisease).toBe(true);
    });

    it.each([[undefined], [false]])(
      'ไม่รับทราบข้อความแจ้ง (%s) -> INFECTION_NOTICE_NOT_ACCEPTED (422) ไม่เขียนอะไร',
      async (accepted) => {
        prisma.careRecipient.findUnique.mockResolvedValue(owned(null));
        const err = await service
          .update(PATIENT_ID, RECIPIENT_ID, { hasInfectiousDisease: false, disclosureNoticeAccepted: accepted })
          .catch((e) => e);
        expect(err.getStatus()).toBe(422);
        expect(err.getResponse()).toMatchObject({ statusCode: 422, code: 'INFECTION_NOTICE_NOT_ACCEPTED' });
        expect(prisma.careRecipient.update).not.toHaveBeenCalled();
      },
    );

    it('แก้ไขก็ต้องรับทราบข้อความแจ้งอีกครั้ง (R3)', async () => {
      prisma.careRecipient.findUnique.mockResolvedValue(owned(false));
      await expect(
        service.update(PATIENT_ID, RECIPIENT_ID, { hasInfectiousDisease: true }),
      ).rejects.toMatchObject({ response: { code: 'INFECTION_NOTICE_NOT_ACCEPTED' } });
    });

    it('ส่งค่าเดิมซ้ำ -> ไม่ขยับ infectious_disease_updated_at (การรับทราบของผู้ดูแลไม่ล้าสมัยโดยไม่จำเป็น)', async () => {
      prisma.careRecipient.findUnique.mockResolvedValue(owned(true));
      await service.update(PATIENT_ID, RECIPIENT_ID, { hasInfectiousDisease: true, disclosureNoticeAccepted: true });
      const data = prisma.careRecipient.update.mock.calls[0][0].data;
      expect(data).not.toHaveProperty('has_infectious_disease');
      expect(data).not.toHaveProperty('infectious_disease_updated_at');
    });

    it('แก้อย่างอื่นโดยไม่ส่ง hasInfectiousDisease -> ไม่แตะค่าและไม่ต้องรับทราบ', async () => {
      prisma.careRecipient.findUnique.mockResolvedValue(owned(true));
      await service.update(PATIENT_ID, RECIPIENT_ID, { name: 'ชื่อใหม่', disclosureNoticeAccepted: true });
      const data = prisma.careRecipient.update.mock.calls[0][0].data;
      expect(data).not.toHaveProperty('has_infectious_disease');
    });

    it('R2/E7: แก้โปรไฟล์ของคนอื่น -> Forbidden ก่อนตรวจ/เขียนอะไร', async () => {
      prisma.careRecipient.findUnique.mockResolvedValue({ ...owned(null), patientId: OTHER_PATIENT });
      await expect(
        service.update(PATIENT_ID, RECIPIENT_ID, { hasInfectiousDisease: true, disclosureNoticeAccepted: true }),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(prisma.careRecipient.update).not.toHaveBeenCalled();
    });
  });

  describe('create', () => {
    it('สร้างพร้อมค่าเมื่อรับทราบ', async () => {
      prisma.careRecipient.create.mockResolvedValue(row({ has_infectious_disease: false }));
      const res = await service.create(PATIENT_ID, {
        name: 'คุณตา',
        hasInfectiousDisease: false,
        disclosureNoticeAccepted: true,
      });
      expect(prisma.careRecipient.create.mock.calls[0][0].data).toMatchObject({
        has_infectious_disease: false,
        infectious_disease_updated_at: NOW,
      });
      expect(res.hasInfectiousDisease).toBe(false);
    });

    it('ไม่รับทราบ -> 422 และไม่สร้างโปรไฟล์', async () => {
      await expect(service.create(PATIENT_ID, { name: 'คุณตา', hasInfectiousDisease: true })).rejects.toMatchObject({
        response: { code: 'INFECTION_NOTICE_NOT_ACCEPTED' },
      });
      expect(prisma.careRecipient.create).not.toHaveBeenCalled();
    });

    it('ไม่ส่งค่า -> สร้างได้ตามเดิม (ยังไม่ได้ระบุ)', async () => {
      prisma.careRecipient.create.mockResolvedValue(row());
      await service.create(PATIENT_ID, { name: 'คุณตา' });
      expect(prisma.careRecipient.create.mock.calls[0][0].data).not.toHaveProperty('has_infectious_disease');
    });
  });

  it('E8: ค่าไม่หลุดลง log', async () => {
    const logSpy = jest.spyOn(service['logger'], 'log').mockImplementation();
    prisma.careRecipient.findUnique.mockResolvedValue(owned(null));
    await service.update(PATIENT_ID, RECIPIENT_ID, { hasInfectiousDisease: true, disclosureNoticeAccepted: true });
    expect(JSON.stringify(logSpy.mock.calls)).not.toMatch(/infect/i);
  });
});
