import { InternalServerErrorException } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { CareLevel, careLevelFromDb } from '../../common/care-level/care-level';
import type { SavedBookingLevel } from './booking-level.types';

/** Serialize the stored snapshot only; never load assessments/rules here. */
export async function readSavedBookingLevels(
  db: Pick<Prisma.TransactionClient, 'booking'>,
  ids: readonly string[],
): Promise<Map<string, SavedBookingLevel>> {
  if (!ids.length) return new Map();
  const rows = await db.booking.findMany({
    where: { id: { in: [...new Set(ids)] } },
    select: {
      id: true,
      requiredLevel: true,
      levelFromAdl: true,
      levelFromFlags: true,
      levelFromServices: true,
      levelCalculatedAt: true,
    },
  });
  return new Map<string, SavedBookingLevel>(
    rows.map((row): [string, SavedBookingLevel] => {
      if (row.levelCalculatedAt == null)
        return [row.id, { requiredLevel: null, levelBreakdown: null }];
      const parse = (
        value: string | null,
        nullable: boolean,
      ): CareLevel | null => {
        if (nullable && value === null) return null;
        const level = careLevelFromDb(value);
        if (!level)
          throw new InternalServerErrorException(
            'ไม่สามารถอ่านระดับ booking ที่บันทึกไว้ได้',
          );
        return level;
      };
      return [
        row.id,
        {
          requiredLevel: parse(row.requiredLevel, false),
          levelBreakdown: {
            adl: parse(row.levelFromAdl, false)!,
            flags: parse(row.levelFromFlags, true),
            services: parse(row.levelFromServices, true),
            calculatedAt: row.levelCalculatedAt,
          },
        },
      ];
    }),
  );
}

export type CareLevelApiName = keyof typeof CareLevel;
export interface RestBookingLevel {
  requiredLevel: CareLevelApiName | null;
  levelBreakdown: {
    adl: CareLevelApiName;
    flags: CareLevelApiName | null;
    services: CareLevelApiName | null;
    calculatedAt: Date;
  } | null;
}
export function bookingLevelForRest(
  value: SavedBookingLevel,
): RestBookingLevel {
  const api = (level: CareLevel | null) =>
    level === null ? null : (level.toUpperCase() as CareLevelApiName);
  return {
    requiredLevel: api(value.requiredLevel),
    levelBreakdown: value.levelBreakdown
      ? {
          adl: api(value.levelBreakdown.adl)!,
          flags: api(value.levelBreakdown.flags),
          services: api(value.levelBreakdown.services),
          calculatedAt: value.levelBreakdown.calculatedAt,
        }
      : null,
  };
}
