/** S09 (PYG-614). Reuse these cutoffs in S16 instead of duplicating them. */
export const HOMEBOUND_MIN_ADL_SCORE = 5;
export const SOCIAL_MIN_ADL_SCORE = 12;
export const MAX_ADL_TOTAL_SCORE = 20;

export type StoredCareGroup = 'social' | 'homebound' | 'bedridden';

/** Public API spelling; DB codes remain lowercase. */
export enum ElderCareGroup {
  SOCIAL = 'SOCIAL',
  HOMEBOUND = 'HOMEBOUND',
  BEDRIDDEN = 'BEDRIDDEN',
}

/** Pure classification. Never accepts a missing/invalid score as bedridden. */
export function classifyCareGroup(adlTotalScore: number): StoredCareGroup {
  if (
    !Number.isInteger(adlTotalScore) ||
    adlTotalScore < 0 ||
    adlTotalScore > MAX_ADL_TOTAL_SCORE
  ) {
    throw new RangeError('ADL total score must be an integer between 0 and 20');
  }
  if (adlTotalScore >= SOCIAL_MIN_ADL_SCORE) return 'social';
  if (adlTotalScore >= HOMEBOUND_MIN_ADL_SCORE) return 'homebound';
  return 'bedridden';
}

/** Serialization only: no score/mobility fallback or database access on reads. */
export function storedCareGroupToApi(value: unknown): ElderCareGroup {
  switch (value) {
    case 'social':
      return ElderCareGroup.SOCIAL;
    case 'homebound':
      return ElderCareGroup.HOMEBOUND;
    case 'bedridden':
      return ElderCareGroup.BEDRIDDEN;
    default:
      // No recipient ID, group value or health answers in this error.
      throw new Error(
        'Stored care group is unavailable; S09 readiness backfill is required',
      );
  }
}
