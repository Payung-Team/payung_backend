/**
 * verifyOmiseSignature — ตรวจลายเซ็น webhook ของ Omise ตามสเปคจริง
 *
 * ── ทำไมต้องเขียนใหม่ทั้งหมด ────────────────────────────────────────────────
 * ของเดิมใน OmiseController ตรวจผิดสเปค 5 จุด ซึ่งแปลว่าต่อให้ตั้ง
 * OMISE_WEBHOOK_SECRET แล้วก็ยัง "ไม่ได้ตรวจอะไรเลย":
 *
 *   1. อ่าน header ชื่อ `x-omise-signature` — ของจริงคือ `Omise-Signature`
 *      → ค่าเป็น undefined เสมอ → ตกไปเข้า else ที่ปล่อยผ่าน
 *   2. ไม่ได้อ่าน `Omise-Signature-Timestamp` เลย
 *   3. เซ็นจาก JSON.stringify(body) ที่ parse แล้ว — ของจริงเซ็นจาก
 *      `<timestamp>.<raw body>` ไบต์ดิบ (re-serialise แล้ว key order/ช่องว่างเพี้ยนได้)
 *   4. ใช้ secret เป็น utf8 — ของจริง secret เป็น base64 ต้อง decode ก่อน
 *   5. เทียบ signature เป็น utf8 — ของจริงเป็น hex และอาจมีหลายค่าคั่นด้วย comma
 *
 * ── ทำไมเรื่องนี้สำคัญกว่าที่เห็น ────────────────────────────────────────────
 * webhook `recipient.verified` คือ "ประตูเดียว" ที่ตั้ง
 * caregiver_payout_accounts.status = 'active' ได้ (ดู PayoutAccountService)
 * ถ้าไม่ตรวจลายเซ็น ใครก็ยิง recipient.verified เข้ามาเพื่อปลดล็อกบัญชีรับเงิน
 * ให้พร้อมรับโอนได้ ทั้งที่ธนาคารยังไม่เคยยืนยันบัญชีนั้น
 *
 * ── replay ────────────────────────────────────────────────────────────────
 * ลายเซ็นที่ถูกต้องใช้ซ้ำได้ตลอดกาลถ้าไม่ดูเวลา จึงปฏิเสธ timestamp ที่เก่ากว่า
 * tolerance (default 5 นาที) — ค่าเดียวกับที่ payment gateway ส่วนใหญ่ใช้
 */
import * as crypto from 'crypto';

/** ระยะเวลาที่ยอมรับความต่างของ timestamp (วินาที) — กัน replay */
export const OMISE_SIGNATURE_TOLERANCE_SECONDS = 300;

export type SignatureVerdict =
  | { ok: true }
  | { ok: false; reason: string };

/**
 * @param rawBody      ไบต์ดิบของ request body (ต้องมาจาก req.rawBody เท่านั้น
 *                     ห้ามใช้ JSON.stringify ของ object ที่ parse แล้ว)
 * @param signatureHeader  ค่าจาก header `Omise-Signature` (hex, อาจมีหลายค่าคั่น comma)
 * @param timestampHeader  ค่าจาก header `Omise-Signature-Timestamp` (unix seconds)
 * @param secretBase64     OMISE_WEBHOOK_SECRET (base64)
 * @param nowMs            เวลาปัจจุบัน — รับเข้ามาเพื่อให้เทสต์คุมเวลาได้
 */
export function verifyOmiseSignature(
  rawBody: Buffer | undefined,
  signatureHeader: string | undefined,
  timestampHeader: string | undefined,
  secretBase64: string,
  nowMs: number = Date.now(),
): SignatureVerdict {
  if (!rawBody || rawBody.length === 0) {
    // ไม่มี raw body = ตรวจไม่ได้ ห้ามเดาว่าผ่าน
    return { ok: false, reason: 'missing_raw_body' };
  }
  if (!signatureHeader) return { ok: false, reason: 'missing_signature_header' };
  if (!timestampHeader) return { ok: false, reason: 'missing_timestamp_header' };

  const timestampSeconds = Number(timestampHeader);
  if (!Number.isFinite(timestampSeconds)) {
    return { ok: false, reason: 'invalid_timestamp' };
  }

  const ageSeconds = Math.abs(nowMs / 1000 - timestampSeconds);
  if (ageSeconds > OMISE_SIGNATURE_TOLERANCE_SECONDS) {
    return { ok: false, reason: `timestamp_out_of_tolerance:${Math.round(ageSeconds)}s` };
  }

  const secret = Buffer.from(secretBase64, 'base64');
  if (secret.length === 0) return { ok: false, reason: 'invalid_secret' };

  // signed payload = "<timestamp>.<raw body>" ตามเอกสาร Omise
  const expected = crypto
    .createHmac('sha256', secret)
    .update(`${timestampHeader}.${rawBody.toString('utf8')}`)
    .digest();

  // header อาจมีหลายลายเซ็นคั่นด้วย comma (ตอนหมุน secret) — ผ่านตัวใดตัวหนึ่งก็พอ
  for (const candidate of signatureHeader.split(',')) {
    const trimmed = candidate.trim();
    if (!/^[0-9a-fA-F]+$/.test(trimmed)) continue;

    const provided = Buffer.from(trimmed, 'hex');
    // timingSafeEqual โยน error ถ้าความยาวไม่เท่ากัน ต้องกันก่อนเสมอ
    if (provided.length !== expected.length) continue;
    if (crypto.timingSafeEqual(provided, expected)) return { ok: true };
  }

  return { ok: false, reason: 'signature_mismatch' };
}
