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
      create: jest.Mock;
      findFirst: jest.Mock;
      findMany: jest.Mock;
    };
  };

  beforeEach(async () => {
    prisma = {
      user_consents: {
        createMany: jest.fn().mockResolvedValue({ count: 0 }),
        // PYG-540: withdraw / grant เขียนทีละแถวผ่าน setConsent — คืนแถวที่เพิ่งเขียน
        //   (สะท้อนค่าที่ส่งไป + เวลาที่ DB ใส่ให้ เหมือน select ของ setConsent)
        create: jest
          .fn()
          .mockImplementation((args: { data: Record<string, unknown> }) =>
            Promise.resolve({
              consent_type: args.data.consent_type,
              granted: args.data.granted,
              policy_version: args.data.policy_version,
              granted_at: new Date('2026-09-22T12:00:00Z'),
              source: args.data.source,
            }),
          ),
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

  // ═══ PYG-540: ถอน / ให้กลับ / หน้าความยินยอมของฉัน ═══════════════════════
  const PATIENT = 1;
  const CAREGIVER = 2;
  const ADMIN = 3;
  const EVIDENCE = { ipAddress: '203.0.113.9', userAgent: 'jest/1.0' };

  /** แถวล่าสุดใน DB (รูปแบบที่ findMany คืน) */
  function row(
    consent_type: string,
    granted: boolean,
    policy_version: string = POLICY_VERSION,
    source: string | null = CONSENT_SOURCE.REGISTER,
  ) {
    return {
      consent_type,
      granted,
      policy_version,
      granted_at: new Date('2026-09-20T08:00:00Z'),
      source,
    };
  }

  describe('withdraw (PYG-540)', () => {
    it('★ เขียนแถวใหม่ granted = false · source settings · หลักฐานครบ (ไม่ UPDATE ของเดิม)', async () => {
      const result = await service.withdraw(
        USER_ID,
        PATIENT,
        CONSENT_TYPE.SENSITIVE_HEALTH_DATA,
        EVIDENCE,
      );

      expect(prisma.user_consents.create).toHaveBeenCalledWith({
        data: {
          user_id: USER_ID,
          consent_type: CONSENT_TYPE.SENSITIVE_HEALTH_DATA,
          policy_version: POLICY_VERSION,
          granted: false,
          source: CONSENT_SOURCE.SETTINGS,
          ip_address: EVIDENCE.ipAddress,
          user_agent: EVIDENCE.userAgent,
        },
        select: {
          consent_type: true,
          granted: true,
          policy_version: true,
          granted_at: true,
          source: true,
        },
      });
      // สถานะที่คืนให้ FE สะท้อนทันที (myConsents ไม่ต้องรอ)
      expect(result).toMatchObject({
        type: CONSENT_TYPE.SENSITIVE_HEALTH_DATA,
        granted: false,
        answered: true,
        source: CONSENT_SOURCE.SETTINGS,
        answeredAt: new Date('2026-09-22T12:00:00Z'),
        required: true,
        withdrawable: true,
      });
    });

    it('★ ถอนข้อที่ไม่เคยให้ความยินยอม → ผ่าน (idempotent) และยังเขียนแถวเป็นหลักฐานการกด', async () => {
      // ไม่มีแถวเดิมเลย — ไม่ต้องอ่านก่อนด้วยซ้ำ
      await expect(
        service.withdraw(USER_ID, PATIENT, CONSENT_TYPE.MARKETING, EVIDENCE),
      ).resolves.toMatchObject({ granted: false });
      expect(prisma.user_consents.create).toHaveBeenCalledTimes(1);
    });

    it.each([CONSENT_TYPE.TERMS_OF_SERVICE, CONSENT_TYPE.PRIVACY_POLICY])(
      '★ ถอน %s → CONSENT_NOT_WITHDRAWABLE และไม่เขียนแถว (ไม่มีผลจริงที่ทำได้นอกจากปิดบัญชี)',
      async (type) => {
        await expect(
          service.withdraw(USER_ID, PATIENT, type, EVIDENCE),
        ).rejects.toMatchObject({
          extensions: {
            code: CONSENT_ERROR.NOT_WITHDRAWABLE,
            consentType: type,
          },
        });
        expect(prisma.user_consents.create).not.toHaveBeenCalled();
      },
    );

    it('ชนิดที่ไม่รู้จัก → CONSENT_TYPE_INVALID', async () => {
      await expect(
        service.withdraw(USER_ID, PATIENT, 'marketting', EVIDENCE),
      ).rejects.toMatchObject({
        extensions: { code: CONSENT_ERROR.TYPE_INVALID },
      });
      expect(prisma.user_consents.create).not.toHaveBeenCalled();
    });

    it('ผู้ดูแลถอนข้อของผู้รับบริการ (ข้อมูลสุขภาพ) → CONSENT_TYPE_INVALID (ไม่มีข้อนี้ในหน้าของเขา)', async () => {
      await expect(
        service.withdraw(
          USER_ID,
          CAREGIVER,
          CONSENT_TYPE.SENSITIVE_HEALTH_DATA,
          EVIDENCE,
        ),
      ).rejects.toMatchObject({
        extensions: { code: CONSENT_ERROR.TYPE_INVALID },
      });
    });

    it('ผู้ดูแลถอน marketing ได้', async () => {
      await expect(
        service.withdraw(USER_ID, CAREGIVER, CONSENT_TYPE.MARKETING, EVIDENCE),
      ).resolves.toMatchObject({ granted: false });
    });
  });

  describe('grant (PYG-540)', () => {
    it('★ ให้ความยินยอมกลับ → แถวใหม่ granted = true ของเวอร์ชันปัจจุบัน', async () => {
      const result = await service.grant(
        USER_ID,
        PATIENT,
        CONSENT_TYPE.MARKETING,
        POLICY_VERSION,
        EVIDENCE,
      );

      const [createArgs] = prisma.user_consents.create.mock.calls[0] as [
        { data: Record<string, unknown> },
      ];
      expect(createArgs.data).toMatchObject({
        consent_type: CONSENT_TYPE.MARKETING,
        granted: true,
        policy_version: POLICY_VERSION,
        source: CONSENT_SOURCE.SETTINGS,
      });
      expect(result).toMatchObject({
        granted: true,
        answered: true,
        isCurrentVersion: true,
      });
    });

    it('★ policyVersion ไม่ตรง → CONSENT_POLICY_VERSION_MISMATCH และไม่เขียน', async () => {
      await expect(
        service.grant(
          USER_ID,
          PATIENT,
          CONSENT_TYPE.MARKETING,
          '0.9',
          EVIDENCE,
        ),
      ).rejects.toMatchObject({
        extensions: {
          code: CONSENT_ERROR.POLICY_VERSION_MISMATCH,
          currentVersion: POLICY_VERSION,
        },
      });
      expect(prisma.user_consents.create).not.toHaveBeenCalled();
    });

    it('re-consent ข้อกำหนดการใช้บริการ (ให้ได้ แม้จะถอนไม่ได้)', async () => {
      await expect(
        service.grant(
          USER_ID,
          PATIENT,
          CONSENT_TYPE.TERMS_OF_SERVICE,
          POLICY_VERSION,
          EVIDENCE,
        ),
      ).resolves.toMatchObject({ granted: true, withdrawable: false });
    });

    it('แอดมินไม่มีรายการความยินยอม → CONSENT_TYPE_INVALID', async () => {
      await expect(
        service.grant(
          USER_ID,
          ADMIN,
          CONSENT_TYPE.MARKETING,
          POLICY_VERSION,
          EVIDENCE,
        ),
      ).rejects.toMatchObject({
        extensions: { code: CONSENT_ERROR.TYPE_INVALID },
      });
    });
  });

  describe('getMyConsents (PYG-540)', () => {
    it('★ ผู้รับบริการเห็นครบ 6 ข้อตามลำดับ — ข้อที่ไม่เคยตอบก็อยู่ในรายการ', async () => {
      prisma.user_consents.findMany.mockResolvedValue([
        row(CONSENT_TYPE.MARKETING, false),
        row(CONSENT_TYPE.TERMS_OF_SERVICE, true),
        row(CONSENT_TYPE.PRIVACY_POLICY, true, '0.9'),
      ]);

      const result = await service.getMyConsents(USER_ID, PATIENT);

      expect(result.map((r) => r.type)).toEqual([
        CONSENT_TYPE.TERMS_OF_SERVICE,
        CONSENT_TYPE.PRIVACY_POLICY,
        CONSENT_TYPE.SENSITIVE_HEALTH_DATA,
        CONSENT_TYPE.DISCLOSE_TO_CAREGIVER,
        CONSENT_TYPE.DISCLOSE_TO_FAMILY_GROUP,
        CONSENT_TYPE.MARKETING,
      ]);
      expect(result[0]).toMatchObject({
        granted: true,
        answered: true,
        isCurrentVersion: true,
        required: true,
        withdrawable: false,
      });
      // ยินยอมไว้กับฉบับเก่า → FE ต้องเสนอให้ยินยอมใหม่
      expect(result[1]).toMatchObject({
        granted: true,
        isCurrentVersion: false,
      });
      // ไม่เคยตอบ → ไม่ยินยอม + ไม่มีวันเวลา
      expect(result[2]).toEqual({
        type: CONSENT_TYPE.SENSITIVE_HEALTH_DATA,
        granted: false,
        answered: false,
        policyVersion: null,
        answeredAt: null,
        source: null,
        isCurrentVersion: false,
        required: true,
        withdrawable: true,
      });
      expect(result[5]).toMatchObject({
        granted: false,
        answered: true,
        required: false,
      });
    });

    it('ผู้ดูแลเห็นเฉพาะข้อของการสมัคร (terms / privacy / marketing)', async () => {
      const result = await service.getMyConsents(USER_ID, CAREGIVER);
      expect(result.map((r) => r.type)).toEqual([
        CONSENT_TYPE.TERMS_OF_SERVICE,
        CONSENT_TYPE.PRIVACY_POLICY,
        CONSENT_TYPE.MARKETING,
      ]);
    });

    it('แอดมิน → [] และไม่ยิง DB', async () => {
      await expect(service.getMyConsents(USER_ID, ADMIN)).resolves.toEqual([]);
      expect(prisma.user_consents.findMany).not.toHaveBeenCalled();
    });
  });

  describe('findWithdrawnType (PYG-540 — ด่านก่อนจอง)', () => {
    const BLOCKING = [
      CONSENT_TYPE.SENSITIVE_HEALTH_DATA,
      CONSENT_TYPE.DISCLOSE_TO_CAREGIVER,
    ];

    it('★ แถวล่าสุดถอนแล้ว → คืนข้อนั้น', async () => {
      prisma.user_consents.findMany.mockResolvedValue([
        { consent_type: CONSENT_TYPE.DISCLOSE_TO_CAREGIVER, granted: false },
        { consent_type: CONSENT_TYPE.DISCLOSE_TO_CAREGIVER, granted: true },
      ]);
      await expect(service.findWithdrawnType(USER_ID, BLOCKING)).resolves.toBe(
        CONSENT_TYPE.DISCLOSE_TO_CAREGIVER,
      );
    });

    it('★ ถอนแล้วให้กลับ (แถวล่าสุด granted = true) → null จองได้อีก', async () => {
      prisma.user_consents.findMany.mockResolvedValue([
        { consent_type: CONSENT_TYPE.SENSITIVE_HEALTH_DATA, granted: true },
        { consent_type: CONSENT_TYPE.SENSITIVE_HEALTH_DATA, granted: false },
      ]);
      await expect(
        service.findWithdrawnType(USER_ID, BLOCKING),
      ).resolves.toBeNull();
    });

    it('★ ยังไม่เคยตอบ (ผู้ใช้ก่อนมีระบบ consent) → null ไม่บล็อก', async () => {
      await expect(
        service.findWithdrawnType(USER_ID, BLOCKING),
      ).resolves.toBeNull();
    });

    it('ถอนทั้งสองข้อ → คืนข้อแรกตามลำดับที่ผู้เรียกส่งมา (ข้อความคงที่)', async () => {
      prisma.user_consents.findMany.mockResolvedValue([
        { consent_type: CONSENT_TYPE.DISCLOSE_TO_CAREGIVER, granted: false },
        { consent_type: CONSENT_TYPE.SENSITIVE_HEALTH_DATA, granted: false },
      ]);
      await expect(service.findWithdrawnType(USER_ID, BLOCKING)).resolves.toBe(
        CONSENT_TYPE.SENSITIVE_HEALTH_DATA,
      );
    });

    it('อ่านเฉพาะข้อที่ถาม ของผู้ใช้คนนี้ เรียงล่าสุดก่อน', async () => {
      await service.findWithdrawnType(USER_ID, BLOCKING);
      expect(prisma.user_consents.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { user_id: USER_ID, consent_type: { in: BLOCKING } },
          orderBy: { granted_at: 'desc' },
        }),
      );
    });
  });

  describe('withdrawnUserIds (PYG-540 — กรองข้อมูลกลุ่มครอบครัว)', () => {
    it('★ คืนเฉพาะคนที่แถวล่าสุดถอน — ไม่เคยตอบ/ให้กลับแล้ว ไม่นับ', async () => {
      prisma.user_consents.findMany.mockResolvedValue([
        { user_id: 'a', granted: false },
        { user_id: 'b', granted: true },
        { user_id: 'b', granted: false },
        { user_id: 'a', granted: true },
      ]);

      const result = await service.withdrawnUserIds(
        ['a', 'b', 'c'],
        CONSENT_TYPE.DISCLOSE_TO_FAMILY_GROUP,
      );
      expect([...result]).toEqual(['a']);
    });

    it('รายชื่อว่าง → Set ว่าง และไม่ยิง DB', async () => {
      await expect(
        service.withdrawnUserIds([], CONSENT_TYPE.DISCLOSE_TO_FAMILY_GROUP),
      ).resolves.toEqual(new Set());
      expect(prisma.user_consents.findMany).not.toHaveBeenCalled();
    });

    it('ตัด id ซ้ำ / ว่าง ก่อนยิง query เดียว', async () => {
      await service.withdrawnUserIds(
        ['a', 'a', '', 'b'],
        CONSENT_TYPE.DISCLOSE_TO_FAMILY_GROUP,
      );
      expect(prisma.user_consents.findMany).toHaveBeenCalledTimes(1);
      expect(prisma.user_consents.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            user_id: { in: ['a', 'b'] },
            consent_type: CONSENT_TYPE.DISCLOSE_TO_FAMILY_GROUP,
          },
        }),
      );
    });
  });

  describe('grantedCurrentUserIds (เปิดเผยโปรไฟล์ส่วนตัวให้กลุ่มตอนจองแทน)', () => {
    it('★ นับเฉพาะแถวล่าสุดที่ยินยอม + เวอร์ชันปัจจุบัน — ไม่เคยตอบ/ถอน/เวอร์ชันเก่า ไม่นับ', async () => {
      prisma.user_consents.findMany.mockResolvedValue([
        { user_id: 'a', granted: true, policy_version: POLICY_VERSION },
        { user_id: 'b', granted: false, policy_version: POLICY_VERSION },
        { user_id: 'b', granted: true, policy_version: POLICY_VERSION },
        { user_id: 'c', granted: true, policy_version: '0.9' },
        { user_id: 'a', granted: false, policy_version: POLICY_VERSION },
      ]);

      const result = await service.grantedCurrentUserIds(
        ['a', 'b', 'c', 'd'],
        CONSENT_TYPE.DISCLOSE_TO_FAMILY_GROUP,
      );
      // a: ถอนแล้วให้กลับ → นับ · b: ล่าสุดถอน · c: เวอร์ชันเก่า · d: ไม่เคยตอบ
      expect([...result]).toEqual(['a']);
    });

    it('รายชื่อว่าง → Set ว่าง และไม่ยิง DB', async () => {
      await expect(
        service.grantedCurrentUserIds([], CONSENT_TYPE.DISCLOSE_TO_FAMILY_GROUP),
      ).resolves.toEqual(new Set());
      expect(prisma.user_consents.findMany).not.toHaveBeenCalled();
    });
  });
});
