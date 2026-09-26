/**
 * CaregiverService.updateProfile — ปิดทางตั้งราคาเอง (PYG-534)
 *
 * ★ อาจารย์ให้ฟีดแบ็ก (Sprint 9): ผู้ดูแลไม่ควรกำหนดราคาเอง
 *   เทสต์ชุดนี้ตรึงว่า:
 *     1. ผู้ดูแลส่ง hourlyRate มา → ไม่ถูกเขียนลงตาราง (ค่าเดิมไม่เปลี่ยน)
 *     2. field อื่นที่ส่งมาพร้อมกันยังแก้ได้ตามเดิม (ไม่ตอบ 400 ทั้ง request)
 *     3. edit log ไม่บันทึก hourlyRate (ไม่งั้น log จะบอกว่าเปลี่ยนราคาทั้งที่ไม่ได้เปลี่ยน)
 *     4. log warning ทุกครั้งที่ยังมี client ส่ง hourlyRate มา — ไว้ตัดสินใจว่าลบ field ได้เมื่อไหร่
 *     5. DTO ยังรับ hourlyRate ได้ผ่าน ValidationPipe ตัวจริง (FE รุ่นเก่าไม่พัง)
 */
import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { ForbiddenException, ValidationPipe } from '@nestjs/common';
import { CaregiverService } from './caregiver.service';
import { PrismaService } from '../../common/prisma.service';
import { SupabaseService } from '../../common/supabase.service';
import { UpdateCaregiverInput } from './dto/update-caregiver.input';

const USER_ID = 'user-cg-1';
const CAREGIVER_ID = 'cg-1';
const CURRENT_RATE = 250;

/** แถว caregiver ในตาราง (ก่อนแก้) — ผ่าน KYC แล้ว มีราคาเดิม 250 บาท */
const existingRow = () => ({
  id: CAREGIVER_ID,
  userId: USER_ID,
  caregiverNumber: 'CG-260926-0001',
  fullName: 'สมศรี ใจดี',
  idCardNumber: '1234567890123',
  gender: null,
  dateOfBirth: null,
  address: 'กรุงเทพฯ',
  phone: '0812345678',
  skills: ['elder_care'],
  experienceYears: 3,
  hourlyRate: CURRENT_RATE,
  bio: 'bio เดิม',
  kycStatus: 'verified',
  kycSubmittedAt: null,
  kycVerifiedAt: null,
  isSearchable: true,
  languages: ['th'],
  resubmitCount: 0,
  createdAt: new Date('2026-09-01T00:00:00Z'),
  updatedAt: new Date('2026-09-01T00:00:00Z'),
});

describe('CaregiverService.updateProfile — ผู้ดูแลตั้งราคาเองไม่ได้ (PYG-534)', () => {
  let service: CaregiverService;
  // tx = ตัวแทน transaction client — update() คืนแถวที่ "ถ้าเขียนจริง" จะได้
  let tx: { caregiver: { update: jest.Mock }; $executeRaw: jest.Mock };
  let prisma: { caregiver: { findUnique: jest.Mock }; $transaction: jest.Mock };
  let warnSpy: jest.SpyInstance;

  /** ดึง data ที่ถูกส่งเข้า caregiver.update = สิ่งที่จะถูกเขียนลงตารางจริง */
  const writtenData = (): Record<string, unknown> => {
    const [arg] = tx.caregiver.update.mock.calls[0] as [
      { data: Record<string, unknown> },
    ];
    return arg.data;
  };

  /** ดึง field_changes ที่ถูกเขียนลง caregiver_edit_logs (param ที่เป็น JSON array) */
  const loggedChanges = (): Array<{ field: string }> => {
    const params = (tx.$executeRaw.mock.calls[0] as unknown[]).slice(1);
    const json = params.find(
      (p): p is string => typeof p === 'string' && p.startsWith('['),
    );
    return JSON.parse(json as string) as Array<{ field: string }>;
  };

  beforeEach(async () => {
    tx = {
      // จำลองพฤติกรรม DB: เขียนเฉพาะ key ที่อยู่ใน data ทับแถวเดิม
      caregiver: {
        update: jest.fn(({ data }: { data: Record<string, unknown> }) =>
          Promise.resolve({ ...existingRow(), ...data }),
        ),
      },
      $executeRaw: jest.fn().mockResolvedValue(1),
    };
    prisma = {
      caregiver: { findUnique: jest.fn().mockResolvedValue(existingRow()) },
      $transaction: jest.fn((cb: (t: typeof tx) => unknown) => cb(tx)),
    };

    const mod: TestingModule = await Test.createTestingModule({
      providers: [
        CaregiverService,
        { provide: PrismaService, useValue: prisma },
        { provide: SupabaseService, useValue: {} },
        { provide: ConfigService, useValue: {} },
      ],
    }).compile();

    service = mod.get(CaregiverService);
    // ปิดเสียง log ในผลเทสต์ + ใช้ตรวจว่า warning ยิงจริง
    warnSpy = jest
      .spyOn(service['logger'], 'warn')
      .mockImplementation(() => undefined);
  });

  describe('hourlyRate ที่ผู้ดูแลส่งมา', () => {
    it('ไม่ถูกเขียนลงตาราง — ราคาในผลลัพธ์ยังเป็นค่าเดิม', async () => {
      const result = await service.updateProfile(USER_ID, { hourlyRate: 999 });

      expect(writtenData()).not.toHaveProperty('hourlyRate');
      expect(result.hourlyRate).toBe(CURRENT_RATE);
    });

    it('ส่งมาแค่ hourlyRate ตัวเดียว → ไม่ลง edit log เลย (ไม่มีอะไรเปลี่ยนจริง)', async () => {
      await service.updateProfile(USER_ID, { hourlyRate: 999 });

      expect(tx.$executeRaw).not.toHaveBeenCalled();
    });

    it('ราคา 0 หรือติดลบก็ไม่ถูกเขียน (ไม่มีช่องให้ตั้งราคาแปลกๆ)', async () => {
      await service.updateProfile(USER_ID, { hourlyRate: 0 });
      await service.updateProfile(USER_ID, { hourlyRate: -50 });

      for (const [arg] of tx.caregiver.update.mock.calls as Array<
        [{ data: object }]
      >) {
        expect(arg.data).not.toHaveProperty('hourlyRate');
      }
    });
  });

  describe('field อื่นยังแก้ได้ตามเดิม', () => {
    it('ส่ง hourlyRate มาพร้อม bio/phone/skills → เขียน field อื่นครบ ยกเว้น hourlyRate', async () => {
      const result = await service.updateProfile(USER_ID, {
        hourlyRate: 999,
        bio: 'bio ใหม่',
        phone: '0899999999',
        skills: ['elder_care', 'dementia_care'],
      });

      expect(writtenData()).toEqual({
        bio: 'bio ใหม่',
        phone: '0899999999',
        skills: ['elder_care', 'dementia_care'],
      });
      expect(result.bio).toBe('bio ใหม่');
      expect(result.hourlyRate).toBe(CURRENT_RATE);
    });

    it('edit log บันทึกเฉพาะ field ที่เปลี่ยนจริง — ไม่มี hourlyRate', async () => {
      await service.updateProfile(USER_ID, {
        hourlyRate: 999,
        bio: 'bio ใหม่',
      });

      expect(tx.$executeRaw).toHaveBeenCalledTimes(1);
      expect(loggedChanges().map((c) => c.field)).toEqual(['bio']);
    });

    it('ไม่ส่ง hourlyRate เลย → ทำงานเหมือนเดิมทุกอย่าง', async () => {
      await service.updateProfile(USER_ID, {
        experienceYears: 5,
        languages: ['th', 'en'],
      });

      expect(writtenData()).toEqual({
        experienceYears: 5,
        languages: ['th', 'en'],
      });
      expect(
        loggedChanges()
          .map((c) => c.field)
          .sort(),
      ).toEqual(['experienceYears', 'languages']);
    });

    it('guard เดิมยังอยู่ — ผู้ดูแลที่ยังไม่ผ่าน KYC แก้ไม่ได้', async () => {
      prisma.caregiver.findUnique.mockResolvedValue({
        ...existingRow(),
        kycStatus: 'pending',
      });

      await expect(
        service.updateProfile(USER_ID, { bio: 'x' }),
      ).rejects.toThrow(ForbiddenException);
      expect(tx.caregiver.update).not.toHaveBeenCalled();
    });
  });

  describe('log warning — ไว้ดูว่ายังมี FE ส่ง hourlyRate มาไหม', () => {
    it('ส่งราคาใหม่มา → warn พร้อม sameAsCurrent = false (มีคนพยายามเปลี่ยนราคา)', async () => {
      await service.updateProfile(USER_ID, { hourlyRate: 999 });

      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(warnSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          event: 'caregiver.profile.hourly_rate_ignored',
          caregiverId: CAREGIVER_ID,
          userId: USER_ID,
          submitted: 999,
          sameAsCurrent: false,
        }),
      );
    });

    it('ส่งราคาเดิมกลับมา (FE รุ่นปัจจุบันทำแบบนี้) → warn พร้อม sameAsCurrent = true', async () => {
      await service.updateProfile(USER_ID, {
        hourlyRate: CURRENT_RATE,
        bio: 'bio ใหม่',
      });

      expect(warnSpy).toHaveBeenCalledWith(
        expect.objectContaining({ sameAsCurrent: true }),
      );
    });

    it('ไม่ส่ง hourlyRate → ไม่ warn (log ต้องเงียบเมื่อ FE เลิกส่งแล้ว)', async () => {
      await service.updateProfile(USER_ID, { bio: 'bio ใหม่' });

      expect(warnSpy).not.toHaveBeenCalled();
    });
  });
});

describe('UpdateCaregiverInput — FE รุ่นเก่าที่ยังส่ง hourlyRate ต้องไม่พัง (PYG-534)', () => {
  // ตั้งค่าเดียวกับ main.ts ทุกตัว — ถ้า main.ts เปลี่ยน ให้แก้ตรงนี้ตาม
  const pipe = new ValidationPipe({
    transform: true,
    whitelist: true,
    forbidNonWhitelisted: true,
  });
  const validate = (value: Record<string, unknown>) =>
    pipe.transform(value, {
      type: 'body',
      metatype: UpdateCaregiverInput,
    }) as Promise<UpdateCaregiverInput>;

  it('ส่ง hourlyRate มาพร้อม field อื่น → ผ่าน validation และ hourlyRate ยังไปถึง service (เพื่อ log)', async () => {
    const input = await validate({ hourlyRate: 300, bio: 'สวัสดี' });

    expect(input.bio).toBe('สวัสดี');
    expect(input.hourlyRate).toBe(300);
  });

  it('hourlyRate ติดลบ → ไม่ตอบ 400 (ค่านี้ถูกทิ้งอยู่แล้ว ไม่ควรทำให้ field อื่นแก้ไม่ได้)', async () => {
    await expect(
      validate({ hourlyRate: -1, bio: 'สวัสดี' }),
    ).resolves.toBeInstanceOf(UpdateCaregiverInput);
  });

  it('validation ของ field อื่นยังทำงานตามเดิม', async () => {
    await expect(
      validate({ hourlyRate: 300, experienceYears: -1 }),
    ).rejects.toThrow();
  });
});
