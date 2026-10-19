import { InternalServerErrorException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { CaregiverProfession } from '../../identity/kyc/profession.constants';
import { PROFESSION_LOCKED_SKILLS } from '../../care-skill/care-skill.constants';
import {
  BookingRequiredSkill,
  RequiredSkillSource,
} from './required-skills.types';

type StoredSkill = {
  code: string;
  nameTh: string;
  nameEn: string;
  sources: string[];
};
const SOURCE_MAP = {
  adl: RequiredSkillSource.ADL,
  flag: RequiredSkillSource.FLAG,
  service: RequiredSkillSource.SERVICE,
};

/** SQL preserves the NULL scalar-list distinction Prisma loses. Never calculate on read. */
export async function readSavedRequiredSkills(
  db: Pick<Prisma.TransactionClient, '$queryRaw'>,
  ids: readonly string[],
): Promise<Map<string, BookingRequiredSkill[] | null>> {
  const result = new Map<string, BookingRequiredSkill[] | null>();
  if (!ids.length) return result;
  const rows = await db.$queryRaw<
    { id: string; codes: string[] | null; items: StoredSkill[] }[]
  >(Prisma.sql`
    SELECT b.id, b.required_skills AS codes,
      COALESCE(jsonb_agg(jsonb_build_object(
        'code', s.code, 'nameTh', s.name_th, 'nameEn', s.name_en, 'sources', r.sources
      )) FILTER (WHERE r.skill_code IS NOT NULL), '[]'::jsonb) AS items
    FROM bookings b
    LEFT JOIN booking_required_skills r ON r.booking_id = b.id
    LEFT JOIN care_skills s ON s.code = r.skill_code
    WHERE b.id::text IN (${Prisma.join([...new Set(ids)])})
    GROUP BY b.id
  `);
  for (const row of rows) {
    const invalid = () =>
      new InternalServerErrorException(
        'ไม่สามารถอ่านรายการทักษะของ booking ได้',
      );
    if (row.codes === null) {
      if (row.items.length) throw invalid();
      result.set(row.id, null);
      continue;
    }
    const codes = [...new Set(row.codes)].sort();
    const items = [...row.items].sort((a, b) =>
      a.code < b.code ? -1 : a.code > b.code ? 1 : 0,
    );
    if (
      codes.length !== row.codes.length ||
      JSON.stringify(codes) !== JSON.stringify(items.map((item) => item.code))
    )
      throw invalid();
    result.set(
      row.id,
      items.map((item) => {
        if (
          !item.code ||
          !item.nameTh ||
          !item.nameEn ||
          !item.sources.length ||
          item.sources.some(
            (source) =>
              !Object.prototype.hasOwnProperty.call(SOURCE_MAP, source),
          )
        )
          throw invalid();
        const locked = PROFESSION_LOCKED_SKILLS[item.code];
        return {
          skill: {
            code: item.code,
            nameTh: item.nameTh,
            nameEn: item.nameEn,
            lockedProfessions: locked ? [locked as CaregiverProfession] : [],
          },
          sources: Object.entries(SOURCE_MAP)
            .filter(([source]) => item.sources.includes(source))
            .map(([, value]) => value),
        };
      }),
    );
  }
  return result;
}
