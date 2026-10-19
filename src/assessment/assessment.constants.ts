/** Sammy: ADL keys/ranges/null scoring, 9 Oct 2026 (PYG-642). */
export const ADL_ITEMS = [
  { code: 'feeding', maxScore: 2 },
  { code: 'grooming', maxScore: 1 },
  { code: 'transfers', maxScore: 3 },
  { code: 'toilet_use', maxScore: 2 },
  { code: 'mobility', maxScore: 3 },
  { code: 'dressing', maxScore: 2 },
  { code: 'stairs', maxScore: 2 },
  { code: 'bathing', maxScore: 1 },
  { code: 'bowels', maxScore: 2 },
  { code: 'bladder', maxScore: 2 },
] as const;
export type AdlCode = (typeof ADL_ITEMS)[number]['code'];
export type AdlAnswers = Record<AdlCode, number | null>;
export const UNSURE_FLAG_THRESHOLD = 3;

/** Family-selected flags only; system 'unsure' is separate (PYG-638). */
export const ASSESSMENT_FLAG_CODES = [
  'ng_tube',
  'urinary_catheter',
  'oxygen',
  'pressure_ulcer',
  'injection',
  'end_of_life',
  'dementia',
  'diabetes',
  'fall_risk',
] as const;
