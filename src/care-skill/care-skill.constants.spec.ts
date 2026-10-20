/**
 * ค่าคงที่ทักษะ + การตรวจ otherSkills ใน DTO — PYG-652
 */
import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import {
  PROFESSION,
  PROFESSIONS,
  PROFESSION_LOCKED_SKILLS,
  isSkillAllowedForProfession,
  normalizeOtherSkills,
} from './care-skill.constants';
import { KycInput } from '../identity/kyc/dto/kyc.input';
import { UpdateCaregiverInput } from '../identity/kyc/dto/update-caregiver.input';

describe('care-skill.constants (PYG-652)', () => {
  it('ทักษะล็อกวิชาชีพ: พยาบาล 5 · นักกายภาพ 1 และทุกค่าเป็นวิชาชีพที่รู้จัก', () => {
    const byProfession = (p: string) =>
      Object.entries(PROFESSION_LOCKED_SKILLS)
        .filter(([, v]) => v === p)
        .map(([k]) => k)
        .sort();
    expect(byProfession(PROFESSION.NURSE)).toEqual([
      'abdominal_wound_care',
      'injection',
      'suction',
      'tracheostomy_care',
      'tube_feeding',
    ]);
    expect(byProfession(PROFESSION.PHYSIOTHERAPIST)).toEqual(['physiotherapy']);
    expect(byProfession(PROFESSION.GENERAL_CAREGIVER)).toEqual([]);
    for (const p of Object.values(PROFESSION_LOCKED_SKILLS))
      expect(PROFESSIONS).toContain(p);
  });

  it('isSkillAllowedForProfession: ทักษะไม่ล็อกได้ทุกวิชาชีพ · ทักษะล็อกได้เฉพาะวิชาชีพของมัน', () => {
    expect(isSkillAllowedForProfession('bathing', 'general_caregiver')).toBe(
      true,
    );
    expect(isSkillAllowedForProfession('injection', 'nurse')).toBe(true);
    expect(isSkillAllowedForProfession('injection', 'general_caregiver')).toBe(
      false,
    );
    expect(isSkillAllowedForProfession('physiotherapy', 'nurse')).toBe(false);
  });

  describe('normalizeOtherSkills', () => {
    it('ตัดช่องว่างหัวท้าย ทิ้งค่าว่าง และตัดค่าซ้ำ (เก็บตัวแรก)', () => {
      expect(
        normalizeOtherSkills([
          '  ทำอาหาร ',
          '',
          '   ',
          'ทำอาหาร',
          'เป็นเพื่อนคุย',
        ]),
      ).toEqual(['ทำอาหาร', 'เป็นเพื่อนคุย']);
    });

    it('ค่าที่ไม่ใช่ array ของ string ปล่อยผ่านให้ validator ปฏิเสธ', () => {
      expect(normalizeOtherSkills('ทำอาหาร')).toBe('ทำอาหาร');
      expect(normalizeOtherSkills(['ok', 1])).toEqual(['ok', 1]);
    });
  });
});

describe('otherSkills ใน KycInput / UpdateCaregiverInput (PYG-652)', () => {
  const kycBase = {
    fullName: 'สมชาย ใจดี',
    idCardNumber: '1101700230708',
    phone: '0812345678',
    skills: ['bathing'],
    experienceYears: 1,
    documentIds: [],
  };

  async function errorsOf(cls: new () => KycInput | UpdateCaregiverInput, plain: object) {
    const instance = plainToInstance(cls, plain);
    const errors = await validate(instance);
    return { instance, fields: errors.map((e) => e.property) };
  }

  for (const [name, cls, base] of [
    ['KycInput', KycInput, kycBase],
    ['UpdateCaregiverInput', UpdateCaregiverInput, {}],
  ] as const) {
    describe(name, () => {
      it('ไม่ส่ง otherSkills → ผ่าน', async () => {
        const { fields } = await errorsOf(cls, base);
        expect(fields).not.toContain('otherSkills');
      });

      it('5 รายการ → ผ่าน และถูกตัดช่องว่างให้', async () => {
        const { instance, fields } = await errorsOf(cls, {
          ...base,
          otherSkills: [' a ', 'b', 'c', 'd', 'e'],
        });
        expect(fields).not.toContain('otherSkills');
        expect(instance.otherSkills).toEqual(['a', 'b', 'c', 'd', 'e']);
      });

      it('6 รายการที่ไม่ซ้ำ → ไม่ผ่าน', async () => {
        const { fields } = await errorsOf(cls, {
          ...base,
          otherSkills: ['a', 'b', 'c', 'd', 'e', 'f'],
        });
        expect(fields).toContain('otherSkills');
      });

      it('6 รายการแต่ซ้ำ/ว่างจนเหลือ 5 → ผ่าน', async () => {
        const { instance, fields } = await errorsOf(cls, {
          ...base,
          otherSkills: ['a', 'b', 'c', 'd', 'e', ' a ', '  '],
        });
        expect(fields).not.toContain('otherSkills');
        expect(instance.otherSkills).toEqual(['a', 'b', 'c', 'd', 'e']);
      });

      it('ค่าที่ไม่ใช่ข้อความ หรือยาวเกิน 100 ตัวอักษร → ไม่ผ่าน', async () => {
        expect(
          (await errorsOf(cls, { ...base, otherSkills: [1] })).fields,
        ).toContain('otherSkills');
        expect(
          (await errorsOf(cls, { ...base, otherSkills: ['x'.repeat(101)] }))
            .fields,
        ).toContain('otherSkills');
      });
    });
  }
});
