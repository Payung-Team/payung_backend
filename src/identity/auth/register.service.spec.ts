/**
 * PYG-474 — เทสของ AuthService.register กับความยินยอม PDPA
 *
 * แยกไฟล์ใหม่เพราะยังไม่เคยมีเทสของ register มาก่อน (ไม่มี auth.service.spec.ts)
 *
 * ธีมที่คุม (ตามการ์ด):
 *   - consent ครบ → สมัครได้ + บันทึก user_consents ครบทุก field
 *   - ขาด required → ปฏิเสธ และ **ไม่สร้าง user เลย** (ทั้ง Supabase Auth และตาราง users)
 *   - policy_version ผิด → ปฏิเสธ และไม่สร้าง user
 *   - users + user_consents อยู่ในทรานแซคชันเดียว — ฝั่ง consent ล้ม = ไม่มี user ค้าง
 *   - IP / user agent / source = 'register' ถูกบันทึกเป็นหลักฐาน
 *
 * ★ ใช้ ConsentService ตัวจริง ไม่ mock — กฎเรื่องข้อบังคับและเวอร์ชันอยู่ในนั้น
 *   (แพตเทิร์นเดียวกับ complete-onboarding.service.spec.ts ของ PYG-538)
 */
import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import {
  ConflictException,
  InternalServerErrorException,
  Logger,
} from '@nestjs/common';
import { GraphQLError } from 'graphql';
import { AuthService } from './auth.service';
import { SupabaseService } from '../../common/supabase.service';
import { PrismaService } from '../../common/prisma.service';
import { CaregiverService } from '../kyc/caregiver.service';
import { ConsentService } from '../../consent/consent.service';
import {
  CONSENT_SOURCE,
  CONSENT_TYPE,
  POLICY_VERSION,
} from '../../consent/consent.constants';
import { CONSENT_ERROR, ConsentError } from '../../consent/consent.errors';
import type { RegisterInput } from './dto/register.input';
import type { ConsentAnswerInput } from '../../consent/dto/consent-answer.input';

const SUPABASE_UID = 'sb-uid-1';
const USER_ID = 'user-new-1';
const EVIDENCE = { ipAddress: '203.0.113.9', userAgent: 'jest/1.0' };

function answer(
  type: string,
  granted = true,
  policyVersion = POLICY_VERSION,
): ConsentAnswerInput {
  return { type, granted, policyVersion };
}

/** ชุดที่ถูกต้องตามหน้าสมัคร: ยอมรับข้อบังคับทั้งสอง + ปฏิเสธ marketing */
const VALID_CONSENTS = [
  answer(CONSENT_TYPE.TERMS_OF_SERVICE),
  answer(CONSENT_TYPE.PRIVACY_POLICY),
  answer(CONSENT_TYPE.MARKETING, false),
];

function makeInput(overrides: Partial<RegisterInput> = {}): RegisterInput {
  return {
    email: 'somsri@example.com',
    password: 'Passw0rd!',
    role: 1,
    consents: VALID_CONSENTS,
    ...overrides,
  };
}

/** แถว users ที่ Prisma คืนมาหลัง create */
function userRow(role = 1) {
  return {
    id: USER_ID,
    email: 'somsri@example.com',
    displayName: 'somsri',
    avatarUrl: null,
    phone: null,
    address: null,
    bio: null,
    role,
    isActive: true,
    is_deleted: false,
    must_change_password: false,
    emailPreferences: true,
    createdAt: new Date('2026-09-22'),
    updatedAt: new Date('2026-09-22'),
  };
}

/** ดึง argument ของการเรียก mock แบบมี type — เลี่ยง any ของ mock.calls */
function callArg<T>(mock: jest.Mock, callIndex = 0, argIndex = 0): T {
  const calls = mock.mock.calls as unknown as T[][];
  return calls[callIndex][argIndex];
}

describe('AuthService.register — ความยินยอม PDPA (PYG-474)', () => {
  let service: AuthService;
  let signUp: jest.Mock;
  let deleteUser: jest.Mock;
  let generateCaregiverNumber: jest.Mock;
  /**
   * ★ แยก tx ออกจาก prisma ตัวนอก — ถ้าเขียนผ่าน prisma ตัวนอกแทน tx
   *   (คือไม่ได้อยู่ในทรานแซคชัน) เทสจะจับได้ทันที
   */
  let tx: {
    user: { create: jest.Mock };
    user_consents: { createMany: jest.Mock };
  };
  let prisma: {
    user: { create: jest.Mock };
    user_consents: { createMany: jest.Mock };
    $transaction: jest.Mock;
  };

  beforeEach(async () => {
    signUp = jest.fn().mockResolvedValue({
      data: {
        user: { id: SUPABASE_UID },
        session: { access_token: 'access-1', refresh_token: 'refresh-1' },
      },
      error: null,
    });
    deleteUser = jest.fn().mockResolvedValue({ data: {}, error: null });
    generateCaregiverNumber = jest.fn().mockResolvedValue('CG-20260922-001');

    tx = {
      user: { create: jest.fn().mockResolvedValue(userRow()) },
      user_consents: { createMany: jest.fn().mockResolvedValue({ count: 3 }) },
    };
    prisma = {
      user: { create: jest.fn() },
      user_consents: { createMany: jest.fn() },
      $transaction: jest.fn((cb: (t: typeof tx) => unknown) => cb(tx)),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AuthService,
        ConsentService,
        { provide: PrismaService, useValue: prisma },
        {
          provide: SupabaseService,
          useValue: {
            getClient: () => ({ auth: { signUp } }),
            getAdminClient: () => ({ auth: { admin: { deleteUser } } }),
          },
        },
        {
          provide: ConfigService,
          useValue: { get: jest.fn(), getOrThrow: jest.fn() },
        },
        { provide: CaregiverService, useValue: { generateCaregiverNumber } },
      ],
    }).compile();

    service = module.get(AuthService);
  });

  /** รัน register ที่คาดว่าจะโดนปฏิเสธเรื่อง consent แล้วคืน error มาให้ตรวจ */
  async function expectConsentRejection(
    input: RegisterInput,
  ): Promise<ConsentError> {
    const err = await service.register(input, EVIDENCE).then(
      () => {
        throw new Error('คาดว่าจะถูกปฏิเสธ แต่สมัครผ่าน');
      },
      (e: unknown) => e as ConsentError,
    );
    // ★ ต้องเป็น GraphQLError ที่มี extensions.code — FE ถึงจะรู้ว่าติดเพราะอะไร
    expect(err).toBeInstanceOf(GraphQLError);
    expect(err).toBeInstanceOf(ConsentError);

    // ★ หัวใจของการ์ด: ปฏิเสธแล้ว "ไม่สร้าง user" — ทั้งบัญชี Supabase และแถวใน users
    expect(signUp).not.toHaveBeenCalled();
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(tx.user.create).not.toHaveBeenCalled();
    expect(tx.user_consents.createMany).not.toHaveBeenCalled();
    return err;
  }

  // ── happy path ───────────────────────────────────────────────────────────
  describe('consent ครบ', () => {
    it('★ สมัครสำเร็จ + บันทึกทุกข้อลง user_consents พร้อมหลักฐานครบ', async () => {
      const result = await service.register(makeInput(), EVIDENCE);

      expect(result.accessToken).toBe('access-1');
      expect(result.refreshToken).toBe('refresh-1');
      expect(result.user.id).toBe(USER_ID);

      expect(tx.user_consents.createMany).toHaveBeenCalledWith({
        data: VALID_CONSENTS.map((c) => ({
          user_id: USER_ID, // ★ ผูกกับ user ที่เพิ่งสร้าง (ถูกคน)
          consent_type: c.type,
          policy_version: POLICY_VERSION,
          granted: c.granted,
          source: CONSENT_SOURCE.REGISTER,
          ip_address: EVIDENCE.ipAddress,
          user_agent: EVIDENCE.userAgent,
        })),
      });
    });

    it('★ users และ user_consents เขียนผ่าน tx เดียวกัน (ไม่ใช่ prisma ตัวนอก)', async () => {
      await service.register(makeInput(), EVIDENCE);

      expect(prisma.$transaction).toHaveBeenCalledTimes(1);
      expect(tx.user.create).toHaveBeenCalledTimes(1);
      expect(tx.user_consents.createMany).toHaveBeenCalledTimes(1);
      expect(prisma.user.create).not.toHaveBeenCalled();
      expect(prisma.user_consents.createMany).not.toHaveBeenCalled();
    });

    it('★ marketing ปฏิเสธ → บันทึกเป็น granted = false (การปฏิเสธก็ต้องพิสูจน์ได้)', async () => {
      await service.register(makeInput(), EVIDENCE);

      const { data } = callArg<{
        data: Array<{ consent_type: string; granted: boolean }>;
      }>(tx.user_consents.createMany);
      expect(
        data.find((r) => r.consent_type === CONSENT_TYPE.MARKETING)?.granted,
      ).toBe(false);
    });

    it('ไม่ส่ง marketing มาเลย → สมัครได้ และไม่แต่งแถว marketing ขึ้นมาเอง', async () => {
      await service.register(
        makeInput({
          consents: [
            answer(CONSENT_TYPE.TERMS_OF_SERVICE),
            answer(CONSENT_TYPE.PRIVACY_POLICY),
          ],
        }),
        EVIDENCE,
      );

      const { data } = callArg<{ data: Array<{ consent_type: string }> }>(
        tx.user_consents.createMany,
      );
      expect(data.map((r) => r.consent_type)).toEqual([
        CONSENT_TYPE.TERMS_OF_SERVICE,
        CONSENT_TYPE.PRIVACY_POLICY,
      ]);
    });

    it('ไม่มี IP / user agent → ยังสมัครได้ และเก็บเป็น null', async () => {
      await service.register(makeInput(), { ipAddress: null, userAgent: null });

      const { data } = callArg<{ data: Array<Record<string, unknown>> }>(
        tx.user_consents.createMany,
      );
      expect(
        data.every((r) => r.ip_address === null && r.user_agent === null),
      ).toBe(true);
    });

    it('ผู้ดูแล (role 2) → สร้างแถว caregiver + consent ในทรานแซคชันเดียวกัน', async () => {
      tx.user.create.mockResolvedValue(userRow(2));

      await service.register(makeInput({ role: 2 }), EVIDENCE);

      expect(generateCaregiverNumber).toHaveBeenCalledTimes(1);
      const createArgs = callArg<{
        data: { role: number; caregiver?: unknown };
      }>(tx.user.create);
      expect(createArgs.data.role).toBe(2);
      expect(createArgs.data.caregiver).toEqual({
        create: { caregiverNumber: 'CG-20260922-001', kycStatus: 'none' },
      });
      expect(tx.user_consents.createMany).toHaveBeenCalledTimes(1);
    });
  });

  // ── ขาด required ─────────────────────────────────────────────────────────
  describe('ขาด required consent → ปฏิเสธและไม่สร้าง user', () => {
    it('★ ไม่ส่ง consents มาเลย (FE เวอร์ชันเก่า) → CONSENT_REQUIRED', async () => {
      const err = await expectConsentRejection(
        makeInput({ consents: undefined }),
      );
      expect(err.extensions).toEqual({
        code: CONSENT_ERROR.REQUIRED,
        consentType: CONSENT_TYPE.TERMS_OF_SERVICE,
      });
    });

    it('ส่งอาร์เรย์ว่าง → CONSENT_REQUIRED', async () => {
      const err = await expectConsentRejection(makeInput({ consents: [] }));
      expect(err.code).toBe(CONSENT_ERROR.REQUIRED);
    });

    it('★ ไม่ยินยอมข้อกำหนดการใช้บริการ → CONSENT_REQUIRED ที่ terms_of_service', async () => {
      const err = await expectConsentRejection(
        makeInput({
          consents: [
            answer(CONSENT_TYPE.TERMS_OF_SERVICE, false),
            answer(CONSENT_TYPE.PRIVACY_POLICY),
          ],
        }),
      );
      expect(err.extensions).toMatchObject({
        consentType: CONSENT_TYPE.TERMS_OF_SERVICE,
      });
    });

    it('★ ขาดประกาศความเป็นส่วนตัว → CONSENT_REQUIRED ที่ privacy_policy', async () => {
      const err = await expectConsentRejection(
        makeInput({
          consents: [
            answer(CONSENT_TYPE.TERMS_OF_SERVICE),
            answer(CONSENT_TYPE.MARKETING),
          ],
        }),
      );
      expect(err.extensions).toMatchObject({
        code: CONSENT_ERROR.REQUIRED,
        consentType: CONSENT_TYPE.PRIVACY_POLICY,
      });
    });
  });

  // ── policy_version ผิด ───────────────────────────────────────────────────
  describe('ส่ง policy_version ผิด → ปฏิเสธและไม่สร้าง user', () => {
    it('★ เวอร์ชันเก่า → CONSENT_POLICY_VERSION_MISMATCH พร้อมบอกเวอร์ชันปัจจุบัน', async () => {
      const err = await expectConsentRejection(
        makeInput({
          consents: VALID_CONSENTS.map((c) => ({ ...c, policyVersion: '0.9' })),
        }),
      );
      expect(err.extensions).toEqual({
        code: CONSENT_ERROR.POLICY_VERSION_MISMATCH,
        currentVersion: POLICY_VERSION,
      });
    });

    it('เวอร์ชันที่ FE แต่งเอง (ไม่ได้มาจาก consentPolicy) → ปฏิเสธ', async () => {
      const err = await expectConsentRejection(
        makeInput({
          consents: VALID_CONSENTS.map((c) => ({
            ...c,
            policyVersion: 'v1.0',
          })),
        }),
      );
      expect(err.code).toBe(CONSENT_ERROR.POLICY_VERSION_MISMATCH);
    });
  });

  // ── ข้อมูลผิดรูป ─────────────────────────────────────────────────────────
  describe('คำตอบผิดรูป → ปฏิเสธและไม่สร้าง user', () => {
    it('★ แอบส่งความยินยอมข้อมูลสุขภาพมากับการสมัคร → CONSENT_TYPE_INVALID', async () => {
      const err = await expectConsentRejection(
        makeInput({
          consents: [
            ...VALID_CONSENTS,
            answer(CONSENT_TYPE.SENSITIVE_HEALTH_DATA),
          ],
        }),
      );
      expect(err.extensions).toEqual({
        code: CONSENT_ERROR.TYPE_INVALID,
        consentType: CONSENT_TYPE.SENSITIVE_HEALTH_DATA,
      });
    });

    it('ส่งข้อเดียวกันซ้ำ → CONSENT_DUPLICATE_ANSWER', async () => {
      const err = await expectConsentRejection(
        makeInput({
          consents: [...VALID_CONSENTS, answer(CONSENT_TYPE.MARKETING, true)],
        }),
      );
      expect(err.code).toBe(CONSENT_ERROR.DUPLICATE_ANSWER);
    });
  });

  // ── ทรานแซคชันล้ม ─────────────────────────────────────────────────────────
  describe('ทรานแซคชันล้มกลางทาง → ไม่มี user ค้าง', () => {
    it('★ บันทึก consent ล้ม → ลบบัญชี Supabase ตามไปด้วย และตอบ 500', async () => {
      // ใน DB จริง tx จะย้อน users ที่เพิ่งสร้างกลับไปด้วย — ที่เหลือคือบัญชี Supabase ที่อยู่นอก tx
      tx.user_consents.createMany.mockRejectedValue(
        new Error('invalid input syntax for type inet'),
      );

      await expect(
        service.register(makeInput(), EVIDENCE),
      ).rejects.toBeInstanceOf(InternalServerErrorException);
      expect(deleteUser).toHaveBeenCalledWith(SUPABASE_UID);
    });

    it('อีเมลซ้ำในตาราง users (P2002) → Conflict + ลบบัญชี Supabase', async () => {
      tx.user.create.mockRejectedValue(
        Object.assign(new Error('Unique'), { code: 'P2002' }),
      );

      await expect(
        service.register(makeInput(), EVIDENCE),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(deleteUser).toHaveBeenCalledWith(SUPABASE_UID);
      expect(tx.user_consents.createMany).not.toHaveBeenCalled();
    });

    it('★ ลบบัญชี Supabase ไม่สำเร็จ (คืน error) → log ดัง ๆ + ยังตอบ error เดิม ไม่ throw ซ้อน', async () => {
      tx.user.create.mockRejectedValue(new Error('db down'));
      deleteUser.mockResolvedValue({
        data: null,
        error: { message: 'not allowed' },
      });
      // deleteUser ไม่ throw แต่คืน error — ถ้าไม่เช็คค่าที่คืนมา บัญชี Supabase จะค้าง
      //   โดยไม่มีใครรู้ เทสนี้ยืนยันว่ามี log ให้ตามไปลบเองได้
      const logError = jest
        .spyOn(Logger.prototype, 'error')
        .mockImplementation(() => undefined);

      await expect(
        service.register(makeInput(), EVIDENCE),
      ).rejects.toBeInstanceOf(InternalServerErrorException);
      expect(deleteUser).toHaveBeenCalledWith(SUPABASE_UID);
      expect(logError).toHaveBeenCalledWith(
        expect.objectContaining({
          event: 'auth.register.rollback_failed',
          supabaseUid: SUPABASE_UID,
          reason: 'not allowed',
        }),
      );
      logError.mockRestore();
    });
  });
});
