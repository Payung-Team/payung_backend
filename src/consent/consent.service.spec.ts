/**
 * PYG-474 — เทสของ ConsentService (ตรวจ / บันทึก / อ่านความยินยอม)
 *
 * ธีมที่คุม:
 *   - error ทุกตัวเป็น ConsentError ที่มี extensions.code → FE แยกเหตุผลได้จริง
 *     (ของเดิมเป็น Bad/ForbiddenException ที่ code หายก่อนถึง FE)
 *   - assertAnswersForSource: ชนิดที่ไม่ได้ขอ ณ จุดนั้น / ส่งซ้ำ / ขาดข้อบังคับ / เวอร์ชันผิด
 *   - recordMany เขียนทุกข้อที่ส่งมา รวมข้อที่ปฏิเสธ พร้อมหลักฐาน
 *   - findLatestByUser เลือกแถวล่าสุดของแต่ละข้อ
 */
import { Test, TestingModule } from '@nestjs/testing';
import { GraphQLError } from 'graphql';
import { ConsentService } from './consent.service';
import { PrismaService } from '../common/prisma.service';
import {
  CONSENT_SOURCE,
  CONSENT_TYPE,
  POLICY_VERSION,
} from './consent.constants';
import { CONSENT_ERROR, ConsentError } from './consent.errors';
import type { ConsentAnswerInput } from './dto/consent-answer.input';

const USER_ID = 'user-consent-1';

/** คำตอบหนึ่งข้อ — ค่าเริ่มต้นคือยินยอม + เวอร์ชันปัจจุบัน */
function answer(
  type: string,
  granted = true,
  policyVersion: string = POLICY_VERSION,
): ConsentAnswerInput {
  return { type, granted, policyVersion };
}

/** ชุดคำตอบที่ถูกต้องของหน้าสมัคร */
const VALID_REGISTER_ANSWERS = [
  answer(CONSENT_TYPE.TERMS_OF_SERVICE),
  answer(CONSENT_TYPE.PRIVACY_POLICY),
  answer(CONSENT_TYPE.MARKETING, false),
];

/** จับ error ที่โยนออกมาแบบ sync เพื่อตรวจ code / extensions */
function catchSync(fn: () => void): ConsentError {
  try {
    fn();
  } catch (err) {
    return err as ConsentError;
  }
  throw new Error('คาดว่าจะ throw แต่ไม่ throw');
}

describe('ConsentService (PYG-474)', () => {
  let service: ConsentService;
  let prisma: {
    user_consents: {
      createMany: jest.Mock;
      findFirst: jest.Mock;
      findMany: jest.Mock;
    };
  };

  beforeEach(async () => {
    prisma = {
      user_consents: {
        createMany: jest.fn().mockResolvedValue({ count: 0 }),
        findFirst: jest.fn().mockResolvedValue(null),
        findMany: jest.fn().mockResolvedValue([]),
      },
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [ConsentService, { provide: PrismaService, useValue: prisma }],
    }).compile();

    service = module.get(ConsentService);
  });

  // ── assertAnswers (ของ PYG-538 — PYG-474 เปลี่ยนชนิด error) ─────────────
  describe('assertAnswers', () => {
    it('★ ขาดข้อบังคับ → ConsentError CONSENT_REQUIRED ที่ FE อ่าน extensions.code ได้', () => {
      const err = catchSync(() =>
        service.assertAnswers([], [CONSENT_TYPE.SENSITIVE_HEALTH_DATA]),
      );

      // ★ ต้องเป็น GraphQLError — Nest จะไม่แตะ แล้ว code ไปถึง FE ครบ
      //   (BadRequestException({code}) แบบเดิมถูกแปลงเป็น INTERNAL_SERVER_ERROR)
      expect(err).toBeInstanceOf(GraphQLError);
      expect(err).toBeInstanceOf(ConsentError);
      expect(err.extensions).toEqual({
        code: CONSENT_ERROR.REQUIRED,
        consentType: CONSENT_TYPE.SENSITIVE_HEALTH_DATA,
      });
    });

    it('ตอบว่าไม่ยินยอมข้อบังคับ → CONSENT_REQUIRED', () => {
      const err = catchSync(() =>
        service.assertAnswers(
          [answer(CONSENT_TYPE.SENSITIVE_HEALTH_DATA, false)],
          [CONSENT_TYPE.SENSITIVE_HEALTH_DATA],
        ),
      );
      expect(err.code).toBe(CONSENT_ERROR.REQUIRED);
    });

    it('★ เวอร์ชันไม่ตรง → CONSENT_POLICY_VERSION_MISMATCH พร้อมบอกเวอร์ชันปัจจุบัน', () => {
      const err = catchSync(() =>
        service.assertAnswers(
          [answer(CONSENT_TYPE.SENSITIVE_HEALTH_DATA, true, '0.9')],
          [CONSENT_TYPE.SENSITIVE_HEALTH_DATA],
        ),
      );
      expect(err.extensions).toEqual({
        code: CONSENT_ERROR.POLICY_VERSION_MISMATCH,
        currentVersion: POLICY_VERSION,
      });
    });

    it('ครบและเวอร์ชันตรง → ผ่าน', () => {
      expect(() =>
        service.assertAnswers(
          [answer(CONSENT_TYPE.SENSITIVE_HEALTH_DATA)],
          [CONSENT_TYPE.SENSITIVE_HEALTH_DATA],
        ),
      ).not.toThrow();
    });
  });

  // ── assertAnswersForSource (PYG-474) ─────────────────────────────────────
  describe('assertAnswersForSource — register', () => {
    const register = (answers: ConsentAnswerInput[]) => () =>
      service.assertAnswersForSource(answers, CONSENT_SOURCE.REGISTER);

    it('ครบทั้ง 3 ข้อ (marketing ปฏิเสธ) → ผ่าน', () => {
      expect(register(VALID_REGISTER_ANSWERS)).not.toThrow();
    });

    it('ไม่ส่ง marketing มาเลย → ผ่าน (ข้อไม่บังคับ)', () => {
      expect(
        register([
          answer(CONSENT_TYPE.TERMS_OF_SERVICE),
          answer(CONSENT_TYPE.PRIVACY_POLICY),
        ]),
      ).not.toThrow();
    });

    it('★ ไม่ส่งอะไรเลย → CONSENT_REQUIRED ที่ข้อกำหนดการใช้บริการ', () => {
      const err = catchSync(register([]));
      expect(err.extensions).toEqual({
        code: CONSENT_ERROR.REQUIRED,
        consentType: CONSENT_TYPE.TERMS_OF_SERVICE,
      });
    });

    it('★ ไม่ยินยอมประกาศความเป็นส่วนตัว → CONSENT_REQUIRED ที่ privacy_policy', () => {
      const err = catchSync(
        register([
          answer(CONSENT_TYPE.TERMS_OF_SERVICE),
          answer(CONSENT_TYPE.PRIVACY_POLICY, false),
        ]),
      );
      expect(err.extensions).toMatchObject({
        code: CONSENT_ERROR.REQUIRED,
        consentType: CONSENT_TYPE.PRIVACY_POLICY,
      });
    });

    it('marketing = true อย่างเดียว ไม่พอ → CONSENT_REQUIRED', () => {
      const err = catchSync(register([answer(CONSENT_TYPE.MARKETING)]));
      expect(err.code).toBe(CONSENT_ERROR.REQUIRED);
    });

    it('★ ส่งข้อที่หน้าสมัครไม่ได้ขอ (ข้อมูลสุขภาพ) → CONSENT_TYPE_INVALID', () => {
      // ★ ถ้าบันทึกให้ = มีหลักฐานว่ายินยอมข้อความที่ผู้ใช้ไม่เคยเห็นบนหน้าสมัคร
      const err = catchSync(
        register([
          ...VALID_REGISTER_ANSWERS,
          answer(CONSENT_TYPE.SENSITIVE_HEALTH_DATA),
        ]),
      );
      expect(err.extensions).toEqual({
        code: CONSENT_ERROR.TYPE_INVALID,
        consentType: CONSENT_TYPE.SENSITIVE_HEALTH_DATA,
      });
    });

    it('ชนิดที่ไม่มีในระบบ (สะกดผิด) → CONSENT_TYPE_INVALID', () => {
      const err = catchSync(
        register([...VALID_REGISTER_ANSWERS.slice(0, 2), answer('marketting')]),
      );
      expect(err.code).toBe(CONSENT_ERROR.TYPE_INVALID);
    });

    it('★ ส่งข้อเดียวกันซ้ำ → CONSENT_DUPLICATE_ANSWER (ตีความไม่ได้)', () => {
      const err = catchSync(
        register([
          ...VALID_REGISTER_ANSWERS,
          answer(CONSENT_TYPE.MARKETING, true),
        ]),
      );
      expect(err.extensions).toEqual({
        code: CONSENT_ERROR.DUPLICATE_ANSWER,
        consentType: CONSENT_TYPE.MARKETING,
      });
    });

    it('★ policyVersion ผิด → CONSENT_POLICY_VERSION_MISMATCH', () => {
      const err = catchSync(
        register([
          answer(CONSENT_TYPE.TERMS_OF_SERVICE, true, '0.9'),
          answer(CONSENT_TYPE.PRIVACY_POLICY, true, '0.9'),
        ]),
      );
      expect(err.code).toBe(CONSENT_ERROR.POLICY_VERSION_MISMATCH);
    });

    it('policyVersion ผิดแค่ข้อไม่บังคับ → ก็ยังปฏิเสธ (เห็นข้อความคนละฉบับ)', () => {
      const err = catchSync(
        register([
          answer(CONSENT_TYPE.TERMS_OF_SERVICE),
          answer(CONSENT_TYPE.PRIVACY_POLICY),
          answer(CONSENT_TYPE.MARKETING, false, '0.9'),
        ]),
      );
      expect(err.code).toBe(CONSENT_ERROR.POLICY_VERSION_MISMATCH);
    });
  });

  // ── recordMany ───────────────────────────────────────────────────────────
  describe('recordMany', () => {
    it('★ เขียนทุกข้อ รวมข้อที่ปฏิเสธ พร้อม source / IP / user agent', async () => {
      await service.recordMany(prisma, USER_ID, VALID_REGISTER_ANSWERS, {
        source: CONSENT_SOURCE.REGISTER,
        ipAddress: '203.0.113.9',
        userAgent: 'jest/1.0',
      });

      expect(prisma.user_consents.createMany).toHaveBeenCalledWith({
        data: [
          {
            user_id: USER_ID,
            consent_type: CONSENT_TYPE.TERMS_OF_SERVICE,
            policy_version: POLICY_VERSION,
            granted: true,
            source: CONSENT_SOURCE.REGISTER,
            ip_address: '203.0.113.9',
            user_agent: 'jest/1.0',
          },
          {
            user_id: USER_ID,
            consent_type: CONSENT_TYPE.PRIVACY_POLICY,
            policy_version: POLICY_VERSION,
            granted: true,
            source: CONSENT_SOURCE.REGISTER,
            ip_address: '203.0.113.9',
            user_agent: 'jest/1.0',
          },
          {
            user_id: USER_ID,
            consent_type: CONSENT_TYPE.MARKETING,
            policy_version: POLICY_VERSION,
            granted: false,
            source: CONSENT_SOURCE.REGISTER,
            ip_address: '203.0.113.9',
            user_agent: 'jest/1.0',
          },
        ],
      });
    });

    it('ไม่มีคำตอบ → ไม่ยิง DB', async () => {
      await service.recordMany(prisma, USER_ID, [], {
        source: CONSENT_SOURCE.REGISTER,
      });
      expect(prisma.user_consents.createMany).not.toHaveBeenCalled();
    });

    it('ไม่มี IP / user agent → เก็บเป็น null', async () => {
      await service.recordMany(
        prisma,
        USER_ID,
        [answer(CONSENT_TYPE.TERMS_OF_SERVICE)],
        {
          source: CONSENT_SOURCE.REGISTER,
        },
      );
      expect(prisma.user_consents.createMany).toHaveBeenCalledWith({
        data: [expect.objectContaining({ ip_address: null, user_agent: null })],
      });
    });
  });

  // ── hasGrantedCurrent (ของ PYG-538 — ยังไม่มีเทสตรง) ─────────────────────
  describe('hasGrantedCurrent', () => {
    it.each([
      [
        'ยินยอม + เวอร์ชันปัจจุบัน',
        { granted: true, policy_version: POLICY_VERSION },
        true,
      ],
      [
        'ถอนแล้ว (แถวล่าสุด granted = false)',
        { granted: false, policy_version: POLICY_VERSION },
        false,
      ],
      [
        'ยินยอมกับนโยบายฉบับเก่า',
        { granted: true, policy_version: '0.9' },
        false,
      ],
      ['ไม่เคยตอบ', null, false],
    ])('%s → %s', async (_label, latest, expected) => {
      prisma.user_consents.findFirst.mockResolvedValue(latest);
      await expect(
        service.hasGrantedCurrent(USER_ID, CONSENT_TYPE.MARKETING),
      ).resolves.toBe(expected);
    });
  });

  // ── findLatestByUser (PYG-474) ───────────────────────────────────────────
  describe('findLatestByUser', () => {
    it('★ คืนแถวล่าสุดของแต่ละข้อ (DB เรียงใหม่ → เก่ามาให้แล้ว)', async () => {
      prisma.user_consents.findMany.mockResolvedValue([
        // marketing: ล่าสุดถอน → ต้องได้แถวนี้ ไม่ใช่แถวที่เคยยินยอม
        {
          consent_type: CONSENT_TYPE.MARKETING,
          granted: false,
          policy_version: POLICY_VERSION,
          granted_at: new Date('2026-09-22T10:00:00Z'),
          source: CONSENT_SOURCE.SETTINGS,
        },
        {
          consent_type: CONSENT_TYPE.TERMS_OF_SERVICE,
          granted: true,
          policy_version: POLICY_VERSION,
          granted_at: new Date('2026-09-20T08:00:00Z'),
          source: CONSENT_SOURCE.REGISTER,
        },
        {
          consent_type: CONSENT_TYPE.MARKETING,
          granted: true,
          policy_version: POLICY_VERSION,
          granted_at: new Date('2026-09-20T08:00:00Z'),
          source: CONSENT_SOURCE.REGISTER,
        },
      ]);

      await expect(service.findLatestByUser(USER_ID)).resolves.toEqual([
        {
          type: CONSENT_TYPE.MARKETING,
          granted: false,
          policyVersion: POLICY_VERSION,
          answeredAt: new Date('2026-09-22T10:00:00Z'),
          source: CONSENT_SOURCE.SETTINGS,
        },
        {
          type: CONSENT_TYPE.TERMS_OF_SERVICE,
          granted: true,
          policyVersion: POLICY_VERSION,
          answeredAt: new Date('2026-09-20T08:00:00Z'),
          source: CONSENT_SOURCE.REGISTER,
        },
      ]);
    });

    it('★ อ่านเฉพาะของผู้ใช้คนนี้ เรียงจากล่าสุด', async () => {
      await service.findLatestByUser(USER_ID);
      expect(prisma.user_consents.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { user_id: USER_ID },
          orderBy: { granted_at: 'desc' },
        }),
      );
    });

    it('ไม่เคยตอบอะไรเลย → []', async () => {
      await expect(service.findLatestByUser(USER_ID)).resolves.toEqual([]);
    });
  });
});
