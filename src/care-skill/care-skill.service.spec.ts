/**
 * CareSkillService — PYG-652
 *
 *  - careSkills(profession): general_caregiver ได้ 9 ทักษะพื้นฐาน · nurse +5 · physiotherapist +physiotherapy
 *  - assertSkillsAllowed: รหัสที่ไม่มี / ปิดใช้ → SKILL_INVALID · ล็อกให้วิชาชีพอื่น → SKILL_NOT_ALLOWED_FOR_PROFESSION
 */
import { Test } from '@nestjs/testing';
import { GraphQLError } from 'graphql';
import { PrismaService } from '../common/prisma.service';
import { CareSkillService } from './care-skill.service';
import { CARE_SKILL_ERROR } from './care-skill.errors';

/** ชุดเดียวกับ seed ของ migration 20261009000000_pyg570_seed_required_skills */
const SEEDED = [
  'transfer_assist',
  'wheelchair_push',
  'feeding_assist',
  'toileting_care',
  'bathing',
  'dressing_assist',
  'pressure_ulcer_care',
  'tube_feeding',
  'dementia_care',
  'glucose_diet_care',
  'injection',
  'physiotherapy',
  'suction',
  'tracheostomy_care',
  'abdominal_wound_care',
];
const BASIC = [
  'bathing',
  'dementia_care',
  'dressing_assist',
  'feeding_assist',
  'glucose_diet_care',
  'pressure_ulcer_care',
  'toileting_care',
  'transfer_assist',
  'wheelchair_push',
];
const NURSE_ONLY = [
  'abdominal_wound_care',
  'injection',
  'suction',
  'tracheostomy_care',
  'tube_feeding',
];

const row = (code: string) => ({
  code,
  nameTh: `th:${code}`,
  nameEn: `en:${code}`,
});

/** จำลอง prisma.careSkill.findMany ตาม where.code.in / where.isActive / orderBy code */
function fakeFindMany(active: string[]) {
  return jest.fn(
    ({ where }: { where: { code?: { in: string[] }; isActive?: boolean } }) => {
      let codes = [...active].sort();
      if (where.code?.in)
        codes = codes.filter((c) => where.code!.in.includes(c));
      return Promise.resolve(codes.map(row));
    },
  );
}

async function expectCareSkillError(
  promise: Promise<unknown>,
  code: string,
  extensions: Record<string, unknown>,
) {
  const err = await promise.then(
    () => {
      throw new Error('expected rejection');
    },
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(GraphQLError);
  expect((err as GraphQLError).extensions).toEqual({ code, ...extensions });
}

describe('CareSkillService (PYG-652)', () => {
  let service: CareSkillService;
  let findMany: jest.Mock;

  async function build(active: string[] = SEEDED) {
    findMany = fakeFindMany(active);
    const mod = await Test.createTestingModule({
      providers: [
        CareSkillService,
        { provide: PrismaService, useValue: { careSkill: { findMany } } },
      ],
    }).compile();
    service = mod.get(CareSkillService);
  }

  beforeEach(() => build());

  describe('listForProfession — careSkills(profession)', () => {
    it('general_caregiver → 9 ทักษะพื้นฐานเท่านั้น', async () => {
      const result = await service.listForProfession('general_caregiver');
      expect(result.map((s) => s.code)).toEqual(BASIC);
    });

    it('nurse → 9 พื้นฐาน + 5 ทักษะพยาบาล (พื้นฐานขึ้นก่อน) ไม่มี physiotherapy', async () => {
      const result = await service.listForProfession('nurse');
      expect(result.map((s) => s.code)).toEqual([...BASIC, ...NURSE_ONLY]);
    });

    it('physiotherapist → 9 พื้นฐาน + physiotherapy ไม่มีทักษะพยาบาล', async () => {
      const result = await service.listForProfession('physiotherapist');
      expect(result.map((s) => s.code)).toEqual([...BASIC, 'physiotherapy']);
    });

    it('คืน code + nameTh + nameEn', async () => {
      const [first] = await service.listForProfession('general_caregiver');
      expect(first).toEqual({
        code: 'bathing',
        nameTh: 'th:bathing',
        nameEn: 'en:bathing',
      });
    });

    it('อ่านเฉพาะทักษะที่ is_active', async () => {
      await service.listForProfession('nurse');
      expect(findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { isActive: true } }),
      );
    });

    it('วิชาชีพที่ไม่รู้จัก → PROFESSION_INVALID และไม่ query', async () => {
      await expectCareSkillError(
        service.listForProfession('doctor'),
        CARE_SKILL_ERROR.PROFESSION_INVALID,
        {
          profession: 'doctor',
        },
      );
      expect(findMany).not.toHaveBeenCalled();
    });
  });

  describe('assertSkillsAllowed — ตรวจก่อนบันทึก', () => {
    it('ทักษะพื้นฐานทั้งหมด ทุกวิชาชีพบันทึกได้', async () => {
      for (const profession of [
        'general_caregiver',
        'nurse',
        'physiotherapist',
      ]) {
        await expect(
          service.assertSkillsAllowed(BASIC, profession),
        ).resolves.toBeUndefined();
      }
    });

    it('nurse บันทึกทักษะพยาบาลได้ · physiotherapist บันทึก physiotherapy ได้', async () => {
      await expect(
        service.assertSkillsAllowed(NURSE_ONLY, 'nurse'),
      ).resolves.toBeUndefined();
      await expect(
        service.assertSkillsAllowed(['physiotherapy'], 'physiotherapist'),
      ).resolves.toBeUndefined();
    });

    it('array ว่าง → ผ่านโดยไม่ query', async () => {
      await expect(
        service.assertSkillsAllowed([], 'general_caregiver'),
      ).resolves.toBeUndefined();
      expect(findMany).not.toHaveBeenCalled();
    });

    it('ค่าเก่าที่ไม่ใช่รหัสกลาง → SKILL_INVALID พร้อมรายการที่ผิด', async () => {
      await expectCareSkillError(
        service.assertSkillsAllowed(
          ['bathing', 'medication', 'cooking'],
          'general_caregiver',
        ),
        CARE_SKILL_ERROR.SKILL_INVALID,
        { skills: ['medication', 'cooking'] },
      );
    });

    it('ทักษะที่ถูกปิดใช้ (is_active = false) → SKILL_INVALID', async () => {
      await build(SEEDED.filter((c) => c !== 'glucose_diet_care'));
      await expectCareSkillError(
        service.assertSkillsAllowed(['glucose_diet_care'], 'general_caregiver'),
        CARE_SKILL_ERROR.SKILL_INVALID,
        { skills: ['glucose_diet_care'] },
      );
    });

    it('general_caregiver เลือกทักษะพยาบาล → SKILL_NOT_ALLOWED_FOR_PROFESSION', async () => {
      await expectCareSkillError(
        service.assertSkillsAllowed(
          ['bathing', 'injection', 'suction'],
          'general_caregiver',
        ),
        CARE_SKILL_ERROR.SKILL_NOT_ALLOWED_FOR_PROFESSION,
        { skills: ['injection', 'suction'], profession: 'general_caregiver' },
      );
    });

    it('nurse เลือก physiotherapy → SKILL_NOT_ALLOWED_FOR_PROFESSION', async () => {
      await expectCareSkillError(
        service.assertSkillsAllowed(['injection', 'physiotherapy'], 'nurse'),
        CARE_SKILL_ERROR.SKILL_NOT_ALLOWED_FOR_PROFESSION,
        { skills: ['physiotherapy'], profession: 'nurse' },
      );
    });

    it('physiotherapist เลือกทักษะพยาบาล → SKILL_NOT_ALLOWED_FOR_PROFESSION', async () => {
      await expectCareSkillError(
        service.assertSkillsAllowed(['tube_feeding'], 'physiotherapist'),
        CARE_SKILL_ERROR.SKILL_NOT_ALLOWED_FOR_PROFESSION,
        { skills: ['tube_feeding'], profession: 'physiotherapist' },
      );
    });

    it('มีทั้งรหัสผิดและทักษะล็อก → แจ้ง SKILL_INVALID ก่อน', async () => {
      await expectCareSkillError(
        service.assertSkillsAllowed(
          ['injection', 'elder_care'],
          'general_caregiver',
        ),
        CARE_SKILL_ERROR.SKILL_INVALID,
        { skills: ['elder_care'] },
      );
    });

    it('ค่าซ้ำใน input → query และแจ้ง error แค่ครั้งเดียวต่อรหัส', async () => {
      await expectCareSkillError(
        service.assertSkillsAllowed(
          ['injection', 'injection'],
          'general_caregiver',
        ),
        CARE_SKILL_ERROR.SKILL_NOT_ALLOWED_FOR_PROFESSION,
        { skills: ['injection'], profession: 'general_caregiver' },
      );
      expect(findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { code: { in: ['injection'] }, isActive: true },
        }),
      );
    });
  });
});
