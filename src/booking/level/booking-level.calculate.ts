import { classifyCareGroup } from '../../common/care-group';
import {
  CareLevel,
  careLevelFromDb,
  highestCareLevel,
} from '../../common/care-level/care-level';
import { BookingLevelError } from './booking-level.errors';
export interface BookingLevelRule {
  source: string;
  code: string;
  variant: string;
  level: string | null;
  isActive: boolean;
}
export interface BookingLevelInputs {
  adlTotalScore: number;
  flags: readonly string[];
  hasUnsureFlag: boolean;
  dementiaSevere: boolean | null;
  services: readonly { code: string | null; careLevel: string | null }[];
}
export interface CalculatedBookingLevel {
  requiredLevel: CareLevel;
  adl: CareLevel;
  flags: CareLevel | null;
  services: CareLevel | null;
}
/** Pure calculation. ADL cutoffs belong exclusively to S09's classifier. */
export function calculateBookingLevel(
  input: BookingLevelInputs,
  rules: readonly BookingLevelRule[],
): CalculatedBookingLevel {
  let adl: CareLevel;
  try {
    const group = classifyCareGroup(input.adlTotalScore);
    adl = {
      social: CareLevel.BASIC,
      homebound: CareLevel.INTERMEDIATE,
      bedridden: CareLevel.ADVANCED,
    }[group];
  } catch {
    throw new BookingLevelError('BOOKING_LEVEL_INPUT_INVALID');
  }
  const key = (source: string, code: string, variant: string) =>
    JSON.stringify([source, code, variant]);
  const byKey = new Map<string, BookingLevelRule>();
  for (const rule of rules) {
    if (!rule.isActive) continue;
    const id = key(rule.source, rule.code, rule.variant);
    if (byKey.has(id))
      throw new BookingLevelError('BOOKING_LEVEL_RULE_INVALID');
    byKey.set(id, rule);
  }
  const parseLevel = (value: string | null): CareLevel | null => {
    if (value === null) return null;
    const level = careLevelFromDb(value);
    if (!level) throw new BookingLevelError('BOOKING_LEVEL_RULE_INVALID');
    return level;
  };
  const flags = highestCareLevel(
    [
      ...new Set([...input.flags, ...(input.hasUnsureFlag ? ['unsure'] : [])]),
    ].map((code) => {
      const variant =
        code === 'dementia' && input.dementiaSevere === true ? 'severe' : '';
      const rule = byKey.get(key('flag', code, variant));
      if (!rule) throw new BookingLevelError('BOOKING_LEVEL_RULE_MISSING');
      return parseLevel(rule.level);
    }),
  );
  const services = highestCareLevel(
    input.services.map((service) => {
      const rule =
        service.code === null
          ? undefined
          : byKey.get(key('service', service.code, ''));
      if (rule) return parseLevel(rule.level);
      if (service.careLevel === null)
        throw new BookingLevelError('BOOKING_LEVEL_RULE_MISSING');
      return parseLevel(service.careLevel);
    }),
  );
  return {
    requiredLevel: highestCareLevel([adl, flags, services])!,
    adl,
    flags,
    services,
  };
}
