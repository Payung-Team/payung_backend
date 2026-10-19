/**
 * OMISE_BANKS — ธนาคารที่รับเป็นบัญชีรับเงินของ caregiver ได้ (PYG-307 / TASK 4)
 *
 * ★ ที่นี่คือ source of truth ที่เดียว — FE ต้องดึงผ่าน query `payoutBankOptions`
 *   ห้าม hardcode รายชื่อธนาคารหรือกฎความยาวซ้ำฝั่ง FE อีก (บทเรียนจากของเดิมที่
 *   FE ตรึงไว้ "10 หลัก" ขณะที่ dropdown มีออมสิน/ธ.ก.ส. อยู่ด้วย → กรอกไม่ผ่านทั้งคู่)
 *
 * ── สองรหัสที่เคยผิดและแก้แล้ว ───────────────────────────────────────────────
 *   tmb    → ttb   TMB ควบรวมกับธนาคารธนชาตเป็น ทีเอ็มบีธนชาต
 *   lhbank → lhb   Land and Houses Bank
 *   สองตัวเดิมสร้าง Omise recipient ไม่ผ่านแน่นอนไม่ว่า FE จะส่งอะไรมา
 *
 * ── เรื่องความยาวเลขบัญชี: ทำไมถึงไม่ใส่ค่าตายตัวต่อธนาคาร ────────────────────
 *   เอกสาร Omise ไม่ได้ระบุกฎความยาวรายธนาคารไว้ ความรู้ที่ว่า "ออมสิน/ธ.ก.ส. 12 หลัก"
 *   เป็นความรู้ทั่วไป ไม่ใช่สเปคที่อ้างอิงได้ ถ้าเดาแล้วใส่เป็นกฎตายตัว เราก็จะทำ
 *   ซ้ำความผิดพลาดเดิม แค่ย้ายที่เกิดจาก FE มาเป็น BE
 *
 *   จึงทำแบบนี้แทน:
 *     1. ทุกธนาคารใช้ช่วงกว้าง 10–15 หลักเป็นค่าตั้งต้น
 *     2. ธนาคารไหนที่ "ทีมยืนยันเอง" แล้วค่อยใส่ `digits` ให้แคบลง
 *     3. ตัวตัดสินสุดท้ายคือ Omise — error จาก createRecipient ถูก map เป็น
 *        PAYOUT_ACCOUNT_NUMBER_INVALID ส่งกลับให้ผู้ใช้แก้
 *   คือยอมให้ผ่านด่านเราแล้วให้ Omise ปฏิเสธ ดีกว่าบล็อกผู้ใช้ด้วยกฎที่เราเดาเอง
 */

/** ช่วงความยาวเลขบัญชีเริ่มต้น ใช้กับธนาคารที่ทีมยังไม่ได้ยืนยันกฎเฉพาะ */
export const PAYOUT_ACCOUNT_DIGITS_MIN = 10;
export const PAYOUT_ACCOUNT_DIGITS_MAX = 15;

export type OmiseBank = {
  /** bank code ที่ส่งให้ Omise (bank_account.brand) — lowercase เสมอ */
  readonly code: string;
  readonly nameTh: string;
  readonly nameEn: string;
  /**
   * ความยาวที่ยอมรับ (จำนวนหลัก) — ใส่ก็ต่อเมื่อทีมยืนยันกับธนาคาร/Omise แล้วเท่านั้น
   * undefined = ยังไม่ยืนยัน → ใช้ช่วง PAYOUT_ACCOUNT_DIGITS_MIN–MAX
   */
  readonly digits?: readonly number[];
};

export const OMISE_BANKS: readonly OmiseBank[] = [
  { code: 'bbl', nameTh: 'ธนาคารกรุงเทพ', nameEn: 'Bangkok Bank' },
  { code: 'kbank', nameTh: 'ธนาคารกสิกรไทย', nameEn: 'Kasikornbank' },
  { code: 'ktb', nameTh: 'ธนาคารกรุงไทย', nameEn: 'Krungthai Bank' },
  { code: 'scb', nameTh: 'ธนาคารไทยพาณิชย์', nameEn: 'Siam Commercial Bank' },
  { code: 'bay', nameTh: 'ธนาคารกรุงศรีอยุธยา', nameEn: 'Bank of Ayudhya (Krungsri)' },
  { code: 'ttb', nameTh: 'ธนาคารทหารไทยธนชาต', nameEn: 'TMBThanachart Bank' },
  { code: 'kk', nameTh: 'ธนาคารเกียรตินาคินภัทร', nameEn: 'Kiatnakin Phatra Bank' },
  { code: 'citi', nameTh: 'ธนาคารซิตี้แบงก์', nameEn: 'Citibank' },
  { code: 'cimb', nameTh: 'ธนาคารซีไอเอ็มบี ไทย', nameEn: 'CIMB Thai Bank' },
  { code: 'uob', nameTh: 'ธนาคารยูโอบี', nameEn: 'United Overseas Bank (Thai)' },
  { code: 'gsb', nameTh: 'ธนาคารออมสิน', nameEn: 'Government Savings Bank' },
  {
    code: 'baac',
    nameTh: 'ธนาคารเพื่อการเกษตรและสหกรณ์การเกษตร (ธ.ก.ส.)',
    nameEn: 'Bank for Agriculture and Agricultural Cooperatives',
  },
  { code: 'ghb', nameTh: 'ธนาคารอาคารสงเคราะห์', nameEn: 'Government Housing Bank' },
  { code: 'tisco', nameTh: 'ธนาคารทิสโก้', nameEn: 'TISCO Bank' },
  { code: 'lhb', nameTh: 'ธนาคารแลนด์ แอนด์ เฮ้าส์', nameEn: 'Land and Houses Bank' },
  { code: 'icbc', nameTh: 'ธนาคารไอซีบีซี (ไทย)', nameEn: 'ICBC (Thai)' },
  { code: 'sc', nameTh: 'ธนาคารสแตนดาร์ดชาร์เตอร์ด (ไทย)', nameEn: 'Standard Chartered (Thai)' },
  { code: 'ibank', nameTh: 'ธนาคารอิสลามแห่งประเทศไทย', nameEn: 'Islamic Bank of Thailand' },
] as const;

/** รหัสธนาคารทั้งหมด — ใช้กับ @IsIn และต้องตรงกับ CHECK constraint ใน DB เป๊ะ */
export const OMISE_BANK_CODES: readonly string[] = OMISE_BANKS.map((b) => b.code);

const BANK_BY_CODE = new Map(OMISE_BANKS.map((b) => [b.code, b]));

export function findOmiseBank(code: string): OmiseBank | undefined {
  return BANK_BY_CODE.get(code);
}

/**
 * normalizeAccountNumber — ตัดทุกอย่างที่ไม่ใช่ตัวเลขทิ้ง
 * ผู้ใช้ copy เลขบัญชีมาจากแอปธนาคารมักติดขีด/เว้นวรรค (`123-4-56789-0`)
 * ต้อง strip ก่อนเสมอ ทั้งตอน validate ตอนเข้ารหัส และตอนส่งให้ Omise
 */
export function normalizeAccountNumber(raw: string): string {
  return (raw ?? '').replace(/\D/g, '');
}

/** ช่วงความยาวที่ยอมรับของธนาคารหนึ่ง ๆ (ไว้โชว์ให้ FE + ใช้ validate) */
export function accountDigitRule(code: string): { min: number; max: number } {
  const bank = findOmiseBank(code);
  if (!bank?.digits?.length) {
    return { min: PAYOUT_ACCOUNT_DIGITS_MIN, max: PAYOUT_ACCOUNT_DIGITS_MAX };
  }
  return { min: Math.min(...bank.digits), max: Math.max(...bank.digits) };
}

/**
 * validateAccountNumberForBank — ตรวจเลขบัญชีเทียบกับกฎของธนาคารนั้น
 * @returns ข้อความ error ภาษาไทย หรือ null ถ้าผ่าน
 */
export function validateAccountNumberForBank(
  code: string,
  normalized: string,
): string | null {
  const bank = findOmiseBank(code);
  if (!bank) return 'ธนาคารที่เลือกไม่รองรับ';

  if (!/^\d+$/.test(normalized)) return 'เลขบัญชีต้องเป็นตัวเลขเท่านั้น';

  // ธนาคารที่ทีมยืนยันความยาวไว้แล้ว → ตรวจแบบเป๊ะ
  if (bank.digits?.length) {
    if (!bank.digits.includes(normalized.length)) {
      const allowed = bank.digits.join(' หรือ ');
      return `เลขบัญชี${bank.nameTh}ต้องมี ${allowed} หลัก`;
    }
    return null;
  }

  // ยังไม่ยืนยัน → ผ่านช่วงกว้าง แล้วปล่อยให้ Omise เป็นคนตัดสิน
  const { min, max } = accountDigitRule(code);
  if (normalized.length < min || normalized.length > max) {
    return `เลขบัญชีต้องมี ${min}–${max} หลัก`;
  }
  return null;
}
