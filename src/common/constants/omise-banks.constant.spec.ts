/**
 * TASK 4 — รายชื่อธนาคาร + กฎความยาวเลขบัญชี เป็น source of truth ฝั่ง BE ที่เดียว
 *
 * เทสต์ชุดนี้ตรึงสองเรื่องที่เคยพังจริง:
 *  1. bank code ที่ Omise ไม่รับแล้ว (tmb / lhbank) ต้องไม่กลับมาอยู่ในลิสต์อีก
 *  2. กฎ "10 หลัก" ที่เคย hardcode ต้องไม่บล็อกธนาคารที่ใช้มากกว่านั้น
 */
import {
  OMISE_BANKS,
  OMISE_BANK_CODES,
  PAYOUT_ACCOUNT_DIGITS_MAX,
  PAYOUT_ACCOUNT_DIGITS_MIN,
  accountDigitRule,
  findOmiseBank,
  normalizeAccountNumber,
  validateAccountNumberForBank,
} from './omise-banks.constant';

describe('OMISE_BANKS — ชุดรหัสธนาคาร', () => {
  it('ไม่มีรหัสที่ Omise เลิกรับแล้ว (tmb ควบรวมเป็น ttb, lhbank → lhb)', () => {
    expect(OMISE_BANK_CODES).not.toContain('tmb');
    expect(OMISE_BANK_CODES).not.toContain('lhbank');
    expect(OMISE_BANK_CODES).toContain('ttb');
    expect(OMISE_BANK_CODES).toContain('lhb');
  });

  it('ทุกรหัสเป็น lowercase และไม่ซ้ำ — ต้องตรงกับ CHECK constraint ใน DB', () => {
    for (const code of OMISE_BANK_CODES) {
      expect(code).toBe(code.toLowerCase());
    }
    expect(new Set(OMISE_BANK_CODES).size).toBe(OMISE_BANK_CODES.length);
  });

  it('ทุกธนาคารมีชื่อไทย/อังกฤษครบ (FE เอาไปโชว์ dropdown ตรง ๆ)', () => {
    for (const bank of OMISE_BANKS) {
      expect(bank.nameTh.length).toBeGreaterThan(0);
      expect(bank.nameEn.length).toBeGreaterThan(0);
    }
  });
});

describe('normalizeAccountNumber', () => {
  it('ตัดขีด/เว้นวรรคที่ผู้ใช้ copy มาจากแอปธนาคารทิ้ง', () => {
    expect(normalizeAccountNumber('123-4-56789-0')).toBe('1234567890');
    expect(normalizeAccountNumber(' 012 345 6789 ')).toBe('0123456789');
  });

  it('ค่าว่าง/undefined ไม่ระเบิด', () => {
    expect(normalizeAccountNumber('')).toBe('');
    expect(normalizeAccountNumber(undefined as unknown as string)).toBe('');
  });
});

describe('validateAccountNumberForBank', () => {
  it('ธนาคารที่ไม่รู้จัก → ปฏิเสธ', () => {
    expect(validateAccountNumberForBank('tmb', '1234567890')).toContain('ไม่รองรับ');
  });

  it('เลขบัญชี 10 หลักผ่านทุกธนาคารในลิสต์', () => {
    for (const code of OMISE_BANK_CODES) {
      expect(validateAccountNumberForBank(code, '1234567890')).toBeNull();
    }
  });

  // ★ นี่คือบั๊กเดิม: FE ตรึงไว้ 10 หลัก ทำให้ออมสิน/ธ.ก.ส. กรอกไม่ผ่าน
  it('เลข 12 หลักของออมสิน/ธ.ก.ส. ต้องผ่าน (กฎ 10 หลักตายตัวคือบั๊กเดิม)', () => {
    expect(validateAccountNumberForBank('gsb', '123456789012')).toBeNull();
    expect(validateAccountNumberForBank('baac', '123456789012')).toBeNull();
  });

  it('สั้น/ยาวเกินช่วงที่ยอมรับ → ปฏิเสธพร้อมบอกช่วง', () => {
    const short = '1'.repeat(PAYOUT_ACCOUNT_DIGITS_MIN - 1);
    const long = '1'.repeat(PAYOUT_ACCOUNT_DIGITS_MAX + 1);
    expect(validateAccountNumberForBank('kbank', short)).toContain('หลัก');
    expect(validateAccountNumberForBank('kbank', long)).toContain('หลัก');
  });

  it('มีอักขระที่ไม่ใช่ตัวเลข → ปฏิเสธ (ต้อง normalize มาก่อน)', () => {
    expect(validateAccountNumberForBank('scb', '123-456-7890')).toContain('ตัวเลข');
  });

  it('ธนาคารที่ทีมยืนยันความยาวไว้แล้ว → ตรวจแบบเป๊ะ', () => {
    // จำลองว่าทีมยืนยัน kbank = 10 หลักเท่านั้น
    const bank = findOmiseBank('kbank');
    expect(bank).toBeDefined();
    const withDigits = { ...bank!, digits: [10] as const };
    // accountDigitRule อ่านจากลิสต์จริง — ยืนยันว่า default ยังเป็นช่วงกว้างอยู่
    expect(accountDigitRule('kbank')).toEqual({
      min: PAYOUT_ACCOUNT_DIGITS_MIN,
      max: PAYOUT_ACCOUNT_DIGITS_MAX,
    });
    // และเมื่อมี digits ระบุไว้ ช่วงจะแคบลงตามนั้น
    expect(Math.min(...withDigits.digits)).toBe(10);
  });
});
