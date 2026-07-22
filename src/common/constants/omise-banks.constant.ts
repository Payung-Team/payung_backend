/**
 * OMISE_BANK_CODES — รายชื่อ bank code ที่ Omise Recipients API รองรับ (bank_account.brand)
 *
 * TODO: verify this list against current Omise dashboard/API docs before shipping
 */
export const OMISE_BANK_CODES = [
  'bbl',
  'kbank',
  'ktb',
  'scb',
  'bay',
  'tmb',
  'kk',
  'citi',
  'cimb',
  'uob',
  'gsb',
  'baac',
  'ghb',
  'tisco',
  'lhbank',
  'icbc',
  'sc',
  'ibank',
] as const;

export type OmiseBankCode = (typeof OMISE_BANK_CODES)[number];
