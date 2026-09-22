/**
 * PYG-498 — เทสของ completeOnboarding + onboardingCompleted
 *
 * แยกไฟล์จาก user.service.spec.ts เดิม เพราะไฟล์นั้น mock prisma ไว้แค่เท่าที่
 * findById / updateProfile ต้องใช้ (ไม่มี careRecipient / $transaction)
 * ถ้าไปขยาย mock ร่วมกัน เทสเดิมจะเสี่ยงพังจากการแก้ setup
 *
 * ธีมที่คุม:
 *   - เฉพาะ role 1 · role อื่น Forbidden และต้องไม่แตะ DB
 *   - ชื่อ/นามสกุลถูก trim และช่องว่างล้วนไม่ผ่าน
 *   - เขียน users + care_recipients ในทรานแซคชันเดียว
 *   - เรียกซ้ำ = อัปเดตใบเดิม ไม่สร้าง is_self ซ้ำ
 *   - ค่าที่บันทึกอ่านกลับด้วย toPatientProfile แล้วตรงกับที่ส่งมา
 *   - display_name ทับเฉพาะตอนที่ยังเป็นค่าเริ่มต้นจากอีเมล
 *   - onboardingCompleted คำนวณจากข้อมูลจริง
 */
import { Test, TestingModule } from '@nestjs/testing';
import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { UserService } from './user.service';
import { PrismaService } from '../../common/prisma.service';
import { ROLE_ID } from '../../common/constants/roles.constant';
import { CompleteOnboardingInput } from './dto/complete-onboarding.input';
import {
  CONSENT_SOURCE,
  CONSENT_TYPE,
  POLICY_VERSION,
} from '../../consent/consent.constants';
import { ConsentService } from '../../consent/consent.service';
import {
  toPatientProfile,
  type PatientProfileRow,
} from '../../patient/patient-profile.mapper';

const USER_ID = 'user-onboard-1';
const EMAIL = 'somsri@example.com';

/** หลักฐานประกอบความยินยอมที่ resolver ดึงจาก request แล้วส่งต่อมา (PYG-538) */
const EVIDENCE = { ipAddress: '203.0.113.9', userAgent: 'jest/1.0' };

function makeInput(overrides: Partial<CompleteOnboardingInput> = {}): CompleteOnboardingInput {
  return {
    firstName: 'สมศรี',
    lastName: 'ใจดี',
    consents: [
      {
        type: CONSENT_TYPE.SENSITIVE_HEALTH_DATA,
        granted: true,
        policyVersion: POLICY_VERSION,
      },
    ],
    details: {
      age: 72,
      gender: 'หญิง',
      supportLevel: 'ช่วยเหลือตัวเองได้เล็กน้อย / ต้องการการช่วยพยุงเดิน',
      weight: 58,
      height: 155,
      bloodGroup: 'O',
      conditions: ['เบาหวาน', 'ความดันสูง'],
      medicines: 'ยาลดความดัน เช้า-เย็น',
      allergies: 'แพ้เพนิซิลิน',
      careInstructions: 'ต้องพยุงเดิน',
      regularHospital: 'โรงพยาบาลศิริราช',
    },
    ...overrides,
  } as CompleteOnboardingInput;
}

/** ดึง argument ของการเรียก mock แบบมี type — เลี่ยง any ของ mock.calls */
function callArg<T>(mock: jest.Mock, callIndex = 0, argIndex = 0): T {
  const calls = mock.mock.calls as unknown as T[][];
  return calls[callIndex][argIndex];
}

describe('UserService — completeOnboarding (PYG-498)', () => {
  let service: UserService;
  let prisma: {
    user: { findUnique: jest.Mock; update: jest.Mock };
    careRecipient: { findFirst: jest.Mock; create: jest.Mock; update: jest.Mock };
    // PYG-538: ความยินยอมถูกเขียนในทรานแซคชันเดียวกับข้อมูลสุขภาพ
    user_consents: { createMany: jest.Mock; findFirst: jest.Mock };
    $transaction: jest.Mock;
  };

  beforeEach(async () => {
    prisma = {
      user: {
        findUnique: jest.fn(),
        update: jest.fn().mockResolvedValue({}),
      },
      careRecipient: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockResolvedValue({ id: 'cr-1' }),
        update: jest.fn().mockResolvedValue({ id: 'cr-1' }),
      },
      user_consents: {
        createMany: jest.fn().mockResolvedValue({ count: 1 }),
        findFirst: jest.fn().mockResolvedValue({
          granted: true,
          policy_version: POLICY_VERSION,
        }),
      },
      // เรียก callback ด้วย prisma ตัวเดียวกัน → assert ผ่าน mock เดิมได้
      $transaction: jest.fn(),
    };
    prisma.$transaction.mockImplementation((cb: (tx: unknown) => unknown) => cb(prisma));

    // ผู้ใช้ปกติ: role 1 และ display_name ยังเป็นค่าเริ่มต้นจากอีเมล
    prisma.user.findUnique.mockImplementation(
      (args: { select?: Record<string, boolean> }) => {
        // เรียกครั้งที่สอง (findById ตอนท้าย) ไม่ได้ส่ง select มา → คืนแถวเต็ม
        if (!args.select) {
          return Promise.resolve({
            id: USER_ID,
            supabaseUid: 'sb-1',
            email: EMAIL,
            displayName: 'สมศรี ใจดี',
            firstName: 'สมศรี',
            lastName: 'ใจดี',
            avatarUrl: null,
            phone: null,
            address: null,
            subDistrict: null,
            district: null,
            province: null,
            postalCode: null,
            bio: null,
            role: ROLE_ID.PATIENT,
            isActive: true,
            is_deleted: false,
            must_change_password: false,
            emailPreferences: true,
            createdAt: new Date('2026-09-01'),
            updatedAt: new Date('2026-09-22'),
          });
        }
        return Promise.resolve({
          id: USER_ID,
          email: EMAIL,
          role: ROLE_ID.PATIENT,
          displayName: 'somsri', // = prefix ของอีเมล
        });
      },
    );

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        UserService,
        // ★ ใช้ ConsentService ตัวจริง ไม่ mock — กฎเรื่องเวอร์ชันและข้อบังคับอยู่ในนั้น
        //   ถ้า mock ทิ้ง เทสจะผ่านโดยไม่ได้ตรวจสิ่งที่การ์ดนี้มีไว้เพื่อป้องกัน
        ConsentService,
        { provide: PrismaService, useValue: prisma },
      ],
    }).compile();

    service = module.get(UserService);
  });

  // ── สิทธิ์ ───────────────────────────────────────────────────────────────
  it('★ ผู้ดูแล (role 2) → Forbidden และไม่แตะ DB เลย', async () => {
    prisma.user.findUnique.mockResolvedValue({
      id: USER_ID,
      email: EMAIL,
      role: ROLE_ID.CAREGIVER,
      displayName: 'somsri',
    });

    await expect(service.completeOnboarding(USER_ID, makeInput(), EVIDENCE)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    // ★ ถ้าปล่อยผ่าน จะได้ใบ is_self ของผู้ดูแลค้างใน DB ที่ไม่มีหน้าจอไหนแสดง
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(prisma.careRecipient.create).not.toHaveBeenCalled();
  });

  it('ไม่พบ user → NotFound', async () => {
    prisma.user.findUnique.mockResolvedValue(null);

    await expect(service.completeOnboarding(USER_ID, makeInput(), EVIDENCE)).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  // ── ชื่อ ─────────────────────────────────────────────────────────────────
  it('ชื่อที่มีแต่ช่องว่าง → 400 (IsNotEmpty ปล่อย " " ผ่าน จึงต้องตรวจหลัง trim)', async () => {
    await expect(
      service.completeOnboarding(USER_ID, makeInput({ firstName: '   ' }), EVIDENCE),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('นามสกุลที่มีแต่ช่องว่าง → 400', async () => {
    await expect(
      service.completeOnboarding(USER_ID, makeInput({ lastName: '\t' }), EVIDENCE),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('ตัดช่องว่างหัวท้ายของชื่อ แล้วประกอบเป็นชื่อเต็มของโปรไฟล์', async () => {
    await service.completeOnboarding(USER_ID, makeInput({ firstName: '  สมศรี  ', lastName: '  ใจดี ' }), EVIDENCE);

    const userUpdate = callArg<{ data: { firstName: string; lastName: string } }>(
      prisma.user.update,
    );
    expect(userUpdate.data.firstName).toBe('สมศรี');
    expect(userUpdate.data.lastName).toBe('ใจดี');

    const created = callArg<{ data: { name: string } }>(prisma.careRecipient.create);
    expect(created.data.name).toBe('สมศรี ใจดี');
  });

  // ── display_name ─────────────────────────────────────────────────────────
  it('display_name ยังเป็นค่าเริ่มต้นจากอีเมล → ทับด้วยชื่อจริง', async () => {
    await service.completeOnboarding(USER_ID, makeInput(), EVIDENCE);

    const userUpdate = callArg<{ data: { displayName?: string } }>(prisma.user.update);
    expect(userUpdate.data.displayName).toBe('สมศรี ใจดี');
  });

  it('★ ผู้ใช้ตั้ง display_name เองแล้ว → ไม่ทับ', async () => {
    prisma.user.findUnique.mockResolvedValue({
      id: USER_ID,
      email: EMAIL,
      role: ROLE_ID.PATIENT,
      displayName: 'ยายศรี',
    });

    await service.completeOnboarding(USER_ID, makeInput(), EVIDENCE);

    const userUpdate = callArg<{ data: { displayName?: string } }>(prisma.user.update);
    expect(userUpdate.data.displayName).toBeUndefined();
  });

  // ── โปรไฟล์ is_self ──────────────────────────────────────────────────────
  it('ยังไม่มีโปรไฟล์ → สร้างใบ is_self เป็นโปรไฟล์ส่วนตัว (ไม่ผูกกลุ่ม)', async () => {
    await service.completeOnboarding(USER_ID, makeInput(), EVIDENCE);

    expect(prisma.careRecipient.update).not.toHaveBeenCalled();
    const created = callArg<{ data: Record<string, unknown> }>(prisma.careRecipient.create);
    expect(created.data).toMatchObject({
      patientId: USER_ID,
      familyGroupId: null,
      is_self: true,
      // ข้อมูลมาจากเจ้าตัวโดยตรง ไม่ใช่คนอื่นกรอกให้ตอนจองแทน
      self_reported: true,
    });
  });

  it('★ เรียกซ้ำ (กลับมาแก้ข้อมูล) → อัปเดตใบเดิม ไม่สร้าง is_self ซ้ำ', async () => {
    prisma.careRecipient.findFirst.mockResolvedValue({ id: 'cr-existing' });

    await service.completeOnboarding(USER_ID, makeInput(), EVIDENCE);

    expect(prisma.careRecipient.create).not.toHaveBeenCalled();
    const updated = callArg<{ where: { id: string }; data: { name: string } }>(
      prisma.careRecipient.update,
    );
    expect(updated.where.id).toBe('cr-existing');
    expect(updated.data.name).toBe('สมศรี ใจดี');
  });

  it('หาใบเดิมเฉพาะที่ยังไม่ถูกลบ และเป็นโปรไฟล์ส่วนตัวเท่านั้น', async () => {
    await service.completeOnboarding(USER_ID, makeInput(), EVIDENCE);

    const query = callArg<{ where: Record<string, unknown> }>(prisma.careRecipient.findFirst);
    expect(query.where).toMatchObject({
      patientId: USER_ID,
      is_self: true,
      familyGroupId: null,
      is_deleted: false,
    });
  });

  it('เขียน users กับ care_recipients ในทรานแซคชันเดียว', async () => {
    await service.completeOnboarding(USER_ID, makeInput(), EVIDENCE);

    // ★ ถ้าแยกกัน แล้วครึ่งหลังล้ม จะได้ user ที่มีชื่อแต่ไม่มีโปรไฟล์
    //   → onboardingCompleted ยัง false ผู้ใช้โดนเด้งกลับมากรอกใหม่ทั้งที่ชื่อบันทึกไปแล้ว
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
  });


  // ── PYG-538: ความยินยอมข้อมูลสุขภาพ (ม.26) ───────────────────────────────
  describe('ความยินยอมข้อมูลสุขภาพ (PYG-538)', () => {
    it('★ ไม่ส่ง consent มาเลย → ปฏิเสธ และไม่เขียนอะไรลง DB แม้แต่ชื่อ', async () => {
      await expect(
        service.completeOnboarding(USER_ID, makeInput({ consents: [] }), EVIDENCE),
      ).rejects.toBeInstanceOf(ForbiddenException);

      // ★ หัวใจของการ์ด: ข้อมูลอ่อนไหวตาม ม.26 ห้ามถูกเก็บก่อนได้รับความยินยอม
      //   และมติคือปฏิเสธทั้งคำขอ ไม่ใช่เก็บบางส่วน
      expect(prisma.$transaction).not.toHaveBeenCalled();
      expect(prisma.user.update).not.toHaveBeenCalled();
      expect(prisma.careRecipient.create).not.toHaveBeenCalled();
      expect(prisma.user_consents.createMany).not.toHaveBeenCalled();
    });

    it('★ ตอบว่าไม่ยินยอม (granted = false) → ปฏิเสธ และไม่เขียนอะไร', async () => {
      const input = makeInput({
        consents: [
          {
            type: CONSENT_TYPE.SENSITIVE_HEALTH_DATA,
            granted: false,
            policyVersion: POLICY_VERSION,
          },
        ],
      });

      await expect(
        service.completeOnboarding(USER_ID, input, EVIDENCE),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('ยินยอมข้ออื่นแต่ไม่ยินยอมข้อสุขภาพ → ปฏิเสธ', async () => {
      const input = makeInput({
        consents: [
          {
            type: CONSENT_TYPE.MARKETING,
            granted: true,
            policyVersion: POLICY_VERSION,
          },
        ],
      });

      await expect(
        service.completeOnboarding(USER_ID, input, EVIDENCE),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('★ policyVersion ไม่ตรงกับเวอร์ชันปัจจุบัน → ปฏิเสธ (ผู้ใช้อ่านคนละฉบับ)', async () => {
      const input = makeInput({
        consents: [
          {
            type: CONSENT_TYPE.SENSITIVE_HEALTH_DATA,
            granted: true,
            policyVersion: '0.9',
          },
        ],
      });

      // ★ ถ้าปล่อยผ่านแล้วบันทึกเวอร์ชันปัจจุบันลงไป = สร้างหลักฐานเท็จว่าเขายินยอม
      //   ข้อความที่เขาไม่เคยเห็น
      await expect(
        service.completeOnboarding(USER_ID, input, EVIDENCE),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('★ ยินยอมครบ → เขียน user_consents ในทรานแซคชันเดียวกับข้อมูลสุขภาพ', async () => {
      await service.completeOnboarding(USER_ID, makeInput(), EVIDENCE);

      // ★ ทรานแซคชันเดียว ถ้าแยกแล้วฝั่งใดล้ม จะได้ข้อมูลสุขภาพที่ไม่มีหลักฐาน
      //   ซึ่งแก้ย้อนหลังไม่ได้เพราะตาราง append-only
      expect(prisma.$transaction).toHaveBeenCalledTimes(1);
      expect(prisma.user_consents.createMany).toHaveBeenCalledTimes(1);
      expect(prisma.careRecipient.create).toHaveBeenCalledTimes(1);
    });

    it('★ บันทึกหลักฐานครบ: source, ip_address, user_agent', async () => {
      await service.completeOnboarding(USER_ID, makeInput(), EVIDENCE);

      const written = callArg<{ data: Record<string, unknown>[] }>(
        prisma.user_consents.createMany,
      );
      expect(written.data).toHaveLength(1);
      expect(written.data[0]).toMatchObject({
        user_id: USER_ID,
        consent_type: CONSENT_TYPE.SENSITIVE_HEALTH_DATA,
        granted: true,
        policy_version: POLICY_VERSION,
        // ★ สามค่านี้คือสิ่งที่ทำให้บันทึกใช้เป็นหลักฐานได้จริง ไม่ใช่แค่ธงในตาราง
        source: CONSENT_SOURCE.ONBOARDING,
        ip_address: EVIDENCE.ipAddress,
        user_agent: EVIDENCE.userAgent,
      });
    });

    it('ข้อที่ปฏิเสธก็ถูกบันทึกด้วย — การปฏิเสธเป็นข้อเท็จจริงที่ต้องพิสูจน์ได้', async () => {
      const input = makeInput({
        consents: [
          {
            type: CONSENT_TYPE.SENSITIVE_HEALTH_DATA,
            granted: true,
            policyVersion: POLICY_VERSION,
          },
          {
            type: CONSENT_TYPE.MARKETING,
            granted: false,
            policyVersion: POLICY_VERSION,
          },
        ],
      });

      await service.completeOnboarding(USER_ID, input, EVIDENCE);

      const written = callArg<{ data: Record<string, unknown>[] }>(
        prisma.user_consents.createMany,
      );
      expect(written.data).toHaveLength(2);
      expect(written.data[1]).toMatchObject({
        consent_type: CONSENT_TYPE.MARKETING,
        granted: false,
      });
    });

    it('เรียกซ้ำ → เขียนแถว consent ใหม่ทุกครั้ง (ตารางเป็นประวัติ append-only)', async () => {
      await service.completeOnboarding(USER_ID, makeInput(), EVIDENCE);
      await service.completeOnboarding(USER_ID, makeInput(), EVIDENCE);

      expect(prisma.user_consents.createMany).toHaveBeenCalledTimes(2);
    });
  });

  // ── ค่าที่บันทึก อ่านกลับได้ตรง ──────────────────────────────────────────
  it('★ ค่าที่บันทึกอ่านกลับด้วย toPatientProfile แล้วตรงกับที่ส่งมา', async () => {
    const input = makeInput();
    await service.completeOnboarding(USER_ID, input, EVIDENCE);

    const created = callArg<{ data: Record<string, unknown> }>(prisma.careRecipient.create);
    // จำลองแถวที่ DB จะคืนกลับมาจากคอลัมน์ที่เพิ่งเขียน
    const row = created.data as unknown as PatientProfileRow;
    const readBack = toPatientProfile(row);

    expect(readBack).toMatchObject({
      age: input.details.age,
      gender: input.details.gender,
      supportLevel: input.details.supportLevel,
      weight: input.details.weight,
      height: input.details.height,
      bloodGroup: input.details.bloodGroup,
      conditions: input.details.conditions,
      medicines: input.details.medicines,
      allergies: input.details.allergies,
      careInstructions: input.details.careInstructions,
      regularHospital: input.details.regularHospital,
    });
  });

  it('ส่งมาเฉพาะช่องบังคับ → ช่องที่ไม่ได้ส่งไม่ถูกเขียน (คง NULL)', async () => {
    await service.completeOnboarding(USER_ID, makeInput({
        details: {
          age: 80,
          gender: 'ชาย',
          supportLevel: 'ช่วยเหลือตัวเองไม่ได้ / ติดเตียง',
        } as CompleteOnboardingInput['details'],
      }), EVIDENCE);

    const created = callArg<{ data: Record<string, unknown> }>(prisma.careRecipient.create);
    expect(created.data.allergies).toBeUndefined();
    expect(created.data.blood_type).toBeUndefined();
    expect(created.data.mobility_level).toBe('bedridden');
    expect(created.data.gender).toBe('male');
  });
});

describe('UserService — isOnboardingCompleted (PYG-498)', () => {
  let service: UserService;
  let findFirst: jest.Mock;
  let consentFindFirst: jest.Mock;

  beforeEach(async () => {
    findFirst = jest.fn().mockResolvedValue(null);
    // ยินยอมอยู่และเวอร์ชันตรง เว้นแต่เทสนั้นจะ override
    consentFindFirst = jest.fn().mockResolvedValue({
      granted: true,
      policy_version: POLICY_VERSION,
    });
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        UserService,
        ConsentService,
        {
          provide: PrismaService,
          useValue: {
            careRecipient: { findFirst },
            user_consents: { findFirst: consentFindFirst },
          },
        },
      ],
    }).compile();
    service = module.get(UserService);
  });

  it('★ role อื่นคืน true เสมอ และไม่ต้อง query', async () => {
    await expect(service.isOnboardingCompleted(USER_ID, ROLE_ID.CAREGIVER)).resolves.toBe(true);
    await expect(service.isOnboardingCompleted(USER_ID, ROLE_ID.ADMIN)).resolves.toBe(true);
    // ★ ถ้าคืน false ผู้ดูแลจะโดนเด้งเข้าหน้าที่เขากรอกไม่ได้แล้ววนไม่จบ
    expect(findFirst).not.toHaveBeenCalled();
  });

  it('ผู้สูงอายุที่ยังไม่มีโปรไฟล์ครบ → false', async () => {
    await expect(service.isOnboardingCompleted(USER_ID, ROLE_ID.PATIENT)).resolves.toBe(false);
  });

  it('ผู้สูงอายุที่มีโปรไฟล์ครบและยังยินยอมอยู่ → true', async () => {
    findFirst.mockResolvedValue({ id: 'cr-1' });
    await expect(service.isOnboardingCompleted(USER_ID, ROLE_ID.PATIENT)).resolves.toBe(true);
  });

  // ── PYG-538: ความยินยอมมีผลต่อสถานะ ────────────────────────────────────
  it('★ ถอนความยินยอมข้อมูลสุขภาพแล้ว → false แม้ข้อมูลเดิมยังอยู่ครบ', async () => {
    findFirst.mockResolvedValue({ id: 'cr-1' });
    // แถวล่าสุดคือการถอน (append-only: การถอน = แถวใหม่ที่ granted = false)
    consentFindFirst.mockResolvedValue({ granted: false, policy_version: POLICY_VERSION });

    // ★ ตรงกับข้อความใน consent ที่บอกผู้ใช้ว่า "ถอนแล้วจะจองต่อไม่ได้"
    //   ถ้ายังคืน true ระบบจะขัดกับสิ่งที่เราสัญญาไว้กับผู้ใช้เอง
    await expect(service.isOnboardingCompleted(USER_ID, ROLE_ID.PATIENT)).resolves.toBe(false);
  });

  it('★ ยินยอมไว้กับนโยบายเวอร์ชันเก่า → false (ต้องขอใหม่ก่อน)', async () => {
    findFirst.mockResolvedValue({ id: 'cr-1' });
    consentFindFirst.mockResolvedValue({ granted: true, policy_version: '0.9' });

    await expect(service.isOnboardingCompleted(USER_ID, ROLE_ID.PATIENT)).resolves.toBe(false);
  });

  it('ไม่ยินยอม → ไม่ต้องไปอ่านโปรไฟล์เลย', async () => {
    consentFindFirst.mockResolvedValue({ granted: false, policy_version: POLICY_VERSION });

    await service.isOnboardingCompleted(USER_ID, ROLE_ID.PATIENT);
    expect(findFirst).not.toHaveBeenCalled();
  });

  it('★ นับเฉพาะใบที่กรอกครบสามช่องบังคับ และยังไม่ถูกลบ', async () => {
    await service.isOnboardingCompleted(USER_ID, ROLE_ID.PATIENT);

    const query = callArg<{ where: Record<string, unknown> }>(findFirst);
    expect(query.where).toMatchObject({
      patientId: USER_ID,
      is_self: true,
      is_deleted: false,
      date_of_birth: { not: null },
      gender: { not: null },
      mobility_level: { not: null },
    });
  });
});
