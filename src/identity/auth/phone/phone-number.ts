/**
 * เบอร์มือถือไทย — ตรวจ แปลง และปิดบัง (PYG-603 · R4, R7, R10 ของ story PYG-562)
 *
 * ── ทำไมมี 3 รูปแบบของเบอร์เดียวกัน ─────────────────────────────────────────
 *   national  "0812345678"    → เก็บใน public.users.phone (รูปเดียวกับข้อมูลเดิม 28 แถว ตามมติ PYG-602
 *                               ที่ไม่แปลงข้อมูลเดิม และผ่าน @MaxLength(10) ของ UpdateProfileInput)
 *   e164      "+66812345678"  → ส่งให้ Supabase Auth (API ของ Supabase รับแบบมีเครื่องหมายบวก)
 *   supabase  "66812345678"   → รูปที่ Supabase "เก็บ" ใน auth.users.phone (ตัดเครื่องหมายบวกออก)
 *                               ใช้ตอน query auth.users ตรง ๆ
 *   ทั้งสามคือเบอร์เดียวกัน — R4: "เบอร์เดียวกันที่พิมพ์ต่างรูปแบบต้องถือเป็นเบอร์เดียวกัน"
 *
 * ── กฎ (ตรงกับ FE: payung_frontend/src/lib/phone.ts → phoneInputIssue) ─────────
 *   มือถือไทยเท่านั้น: 10 หลัก ขึ้นต้น 06 / 08 / 09 · เบอร์บ้านและเบอร์ต่างประเทศไม่รับ
 *   ถ้าวันหนึ่งเคาะให้รับเบอร์ต่างประเทศ ต้องแก้ทั้งไฟล์นี้และฝั่ง FE พร้อมกัน
 *
 * ไฟล์นี้ไม่รู้จัก NestJS / Supabase เลย → เทสได้โดยไม่ต้องบูตอะไร
 */

/** เบอร์ที่ผ่านการตรวจแล้ว พร้อมทุกรูปแบบที่ระบบใช้ */
export interface ThaiMobile {
  /** "0812345678" — รูปที่เก็บใน public.users.phone และคืนใน User.phone */
  national: string;
  /** "+66812345678" — รูปที่ส่งให้ Supabase Auth API */
  e164: string;
  /** "66812345678" — รูปที่ Supabase เก็บใน auth.users.phone */
  supabase: string;
}

/**
 * ความยาวสูงสุดของข้อความที่ยอมรับก่อนตรวจ — กันคนส่งสตริงยาวผิดปกติมาให้ regex ทำงานหนัก
 * เบอร์ที่ยาวที่สุดที่คนพิมพ์จริงคือ "+66 (0) 81-234-5678" ไม่ถึง 25 ตัวอักษร
 */
const MAX_RAW_LENGTH = 32;

/**
 * ตัวอักษรที่อนุญาตในเบอร์ที่ผู้ใช้พิมพ์: ตัวเลข ช่องว่าง ขีด จุด วงเล็บ และ + ข้างหน้าสุด
 * ★ ไม่ใช้วิธี "ตัดทุกอย่างที่ไม่ใช่ตัวเลขทิ้ง" เฉย ๆ — "abc0812345678" จะผ่านทั้งที่ไม่ใช่เบอร์
 */
const ALLOWED_CHARS = /^\+?[\d\s\-().]+$/;

/** มือถือไทยในรูป 10 หลัก: 0 + (6|8|9) + ตัวเลขอีก 8 หลัก */
const THAI_MOBILE_NATIONAL = /^0[689]\d{8}$/;

/**
 * ตรวจและแปลงเบอร์ที่ผู้ใช้พิมพ์ — ไม่ผ่านคืน null (ผู้เรียกตอบ PHONE_INVALID_FORMAT)
 *
 * รับได้ (หลังตัดขีด/ช่องว่าง/วงเล็บ/จุด):
 *   "0812345678"     → 10 หลักขึ้นต้น 0
 *   "+66812345678"   → รหัสประเทศ (มีหรือไม่มี + ก็ได้)
 *   "+660812345678"  → คนพิมพ์ 0 ซ้ำหลังรหัสประเทศ (เจอบ่อย FE ก็รองรับ)
 */
export function parseThaiMobile(raw: unknown): ThaiMobile | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!trimmed || trimmed.length > MAX_RAW_LENGTH) return null;
  if (!ALLOWED_CHARS.test(trimmed)) return null;

  const digits = trimmed.replace(/\D/g, '');

  let national: string;
  if (digits.length === 12 && digits.startsWith('660')) {
    national = digits.slice(2); // "660812345678" → "0812345678"
  } else if (digits.length === 11 && digits.startsWith('66')) {
    national = `0${digits.slice(2)}`; // "66812345678" → "0812345678"
  } else {
    national = digits;
  }

  if (!THAI_MOBILE_NATIONAL.test(national)) return null;

  const subscriber = national.slice(1); // "812345678"
  return {
    national,
    e164: `+66${subscriber}`,
    supabase: `66${subscriber}`,
  };
}

/**
 * ปิดบังเบอร์สำหรับเขียน log — "0812345678" → "081XXX5678" (R10: ห้ามเขียนเบอร์เต็มลง log)
 * เหลือ 3 ตัวหน้าและ 4 ตัวท้ายพอให้ทีมไล่ปัญหาได้ ("เบอร์ที่ลงท้าย 5678 ส่งไม่ออก")
 */
export function maskPhone(phone: ThaiMobile): string {
  const n = phone.national;
  return `${n.slice(0, 3)}XXX${n.slice(-4)}`;
}

/**
 * ทุกรูปแบบที่เบอร์นี้อาจถูกเก็บไว้ใน public.users.phone
 *
 * ข้อมูลเดิม 28 แถวเป็น "0XXXXXXXXX" ทั้งหมด (ผลสำรวจ PYG-602) แต่คอลัมน์นี้ไม่มี CHECK
 * ใครก็เขียนรูปอื่นลงมาได้ (เช่น แอดมินแก้ผ่าน AdminEditUserInput ที่ไม่ตรวจรูปแบบ)
 * → ตอนค้นหาให้ลองทุกรูปที่เป็นไปได้ ดีกว่าพลาดบัญชีที่มีอยู่จริง
 */
export function profilePhoneVariants(phone: ThaiMobile): string[] {
  return [phone.national, phone.e164, phone.supabase];
}

/** เบอร์สองค่าเป็นเบอร์เดียวกันหรือไม่ (รูปแบบไหนก็ได้) — ค่าที่ตรวจไม่ผ่านถือว่าไม่ตรง */
export function isSamePhone(a: unknown, b: unknown): boolean {
  const pa = parseThaiMobile(a);
  const pb = parseThaiMobile(b);
  return pa !== null && pb !== null && pa.national === pb.national;
}
