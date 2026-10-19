import { Injectable } from '@nestjs/common';
import { PrismaService } from '../common/prisma.service';
import { CareSkillItem } from './entities/care-skill.entity';
import { CARE_SKILL_ERROR, CareSkillError } from './care-skill.errors';
import {
  PROFESSION_LOCKED_SKILLS,
  isProfession,
  isSkillAllowedForProfession,
} from './care-skill.constants';

/**
 * ทักษะกลางของผู้ดูแล (care_skills) — PYG-652
 *
 * - listForProfession: รายการที่วิชาชีพนั้นเลือกได้ (หน้า KYC / แก้โปรไฟล์)
 * - assertSkillsAllowed: ตรวจก่อนบันทึก caregivers.skills ทุกครั้ง
 *
 * การล็อกวิชาชีพอ่านจาก PROFESSION_LOCKED_SKILLS ที่เดียว (care-skill.constants.ts)
 */
@Injectable()
export class CareSkillService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * ทักษะที่วิชาชีพนี้เลือกได้ — ทักษะพื้นฐานก่อน แล้วตามด้วยทักษะเฉพาะวิชาชีพ
   * เฉพาะรายการที่ is_active
   */
  async listForProfession(profession: string): Promise<CareSkillItem[]> {
    if (!isProfession(profession)) {
      throw new CareSkillError(
        `ไม่รู้จักวิชาชีพ "${profession}"`,
        CARE_SKILL_ERROR.PROFESSION_INVALID,
        { profession },
      );
    }

    const rows = await this.prisma.careSkill.findMany({
      where: { isActive: true },
      select: { code: true, nameTh: true, nameEn: true },
      orderBy: { code: 'asc' },
    });

    const allowed = rows.filter((row) =>
      isSkillAllowedForProfession(row.code, profession),
    );
    const isLocked = (code: string) =>
      PROFESSION_LOCKED_SKILLS[code] !== undefined;
    return [
      ...allowed.filter((row) => !isLocked(row.code)),
      ...allowed.filter((row) => isLocked(row.code)),
    ];
  }

  /**
   * ตรวจทักษะก่อนบันทึก — ทุกค่าต้องเป็นรหัสกลางที่เปิดใช้อยู่ และวิชาชีพของผู้ดูแลถือได้
   *
   * @throws CareSkillError SKILL_INVALID — มีรหัสที่ไม่อยู่ในรายการกลาง (หรือถูกปิดใช้)
   * @throws CareSkillError SKILL_NOT_ALLOWED_FOR_PROFESSION — มีทักษะที่ล็อกให้วิชาชีพอื่น
   */
  async assertSkillsAllowed(
    skills: readonly string[],
    profession: string,
  ): Promise<void> {
    if (skills.length === 0) return;

    const unique = [...new Set(skills)];
    const found = await this.prisma.careSkill.findMany({
      where: { code: { in: unique }, isActive: true },
      select: { code: true },
    });
    const known = new Set(found.map((row) => row.code));

    const invalid = unique.filter((code) => !known.has(code));
    if (invalid.length > 0) {
      throw new CareSkillError(
        `ไม่พบทักษะ: ${invalid.join(', ')} — เลือกจากรายการทักษะของระบบ หรือกรอกในช่องทักษะอื่น ๆ`,
        CARE_SKILL_ERROR.SKILL_INVALID,
        { skills: invalid },
      );
    }

    const notAllowed = unique.filter(
      (code) => !isSkillAllowedForProfession(code, profession),
    );
    if (notAllowed.length > 0) {
      throw new CareSkillError(
        `วิชาชีพของคุณเลือกทักษะนี้ไม่ได้: ${notAllowed.join(', ')}`,
        CARE_SKILL_ERROR.SKILL_NOT_ALLOWED_FOR_PROFESSION,
        { skills: notAllowed, profession },
      );
    }
  }
}
