/**
 * verifyOmiseSignature — เทสต์ตรึงสเปคจริงของ Omise
 *
 * เทสต์ชุดนี้มีไว้กันของเดิมกลับมา: การตรวจแบบเก่าอ่าน header `x-omise-signature`
 * ซึ่งไม่มีอยู่จริง แล้วปล่อยผ่านเงียบ ๆ เมื่อไม่เจอ header
 * (webhook recipient.verified = ประตูเดียวที่ปลดล็อกบัญชีรับเงินให้พร้อมรับโอน)
 */
import * as crypto from 'crypto';
import {
  OMISE_SIGNATURE_TOLERANCE_SECONDS,
  verifyOmiseSignature,
} from './omise-signature';

const SECRET_B64 = Buffer.from('super-secret-key-for-tests-32byte').toString('base64');
const RAW = Buffer.from('{"key":"recipient.verified","data":{"id":"recp_test_1"}}', 'utf8');
const NOW_MS = 1_757_000_000_000;
const TS = String(Math.floor(NOW_MS / 1000));

/** เซ็นแบบเดียวกับที่ Omise ทำ: HMAC-SHA256 ของ "<timestamp>.<raw body>" → hex */
function sign(rawBody: Buffer, timestamp: string, secretB64 = SECRET_B64): string {
  return crypto
    .createHmac('sha256', Buffer.from(secretB64, 'base64'))
    .update(`${timestamp}.${rawBody.toString('utf8')}`)
    .digest('hex');
}

describe('verifyOmiseSignature', () => {
  it('ลายเซ็นถูกต้อง → ผ่าน', () => {
    const sig = sign(RAW, TS);
    expect(verifyOmiseSignature(RAW, sig, TS, SECRET_B64, NOW_MS)).toEqual({ ok: true });
  });

  it('รับหลายลายเซ็นคั่น comma (ตอนหมุน secret) → ผ่านถ้าตัวใดตัวหนึ่งถูก', () => {
    const good = sign(RAW, TS);
    const header = `${'a'.repeat(64)}, ${good}`;
    expect(verifyOmiseSignature(RAW, header, TS, SECRET_B64, NOW_MS)).toEqual({ ok: true });
  });

  // ── จุดที่ของเดิมพลาด ────────────────────────────────────────────────────
  it('ไม่มี signature header → ปฏิเสธ (ของเดิมปล่อยผ่าน)', () => {
    expect(verifyOmiseSignature(RAW, undefined, TS, SECRET_B64, NOW_MS)).toEqual({
      ok: false,
      reason: 'missing_signature_header',
    });
  });

  it('ไม่มี timestamp header → ปฏิเสธ (ของเดิมไม่เคยอ่าน header นี้เลย)', () => {
    const sig = sign(RAW, TS);
    expect(verifyOmiseSignature(RAW, sig, undefined, SECRET_B64, NOW_MS)).toEqual({
      ok: false,
      reason: 'missing_timestamp_header',
    });
  });

  it('ไม่มี rawBody → ปฏิเสธ ไม่เดาว่าผ่าน', () => {
    const sig = sign(RAW, TS);
    expect(verifyOmiseSignature(undefined, sig, TS, SECRET_B64, NOW_MS)).toEqual({
      ok: false,
      reason: 'missing_raw_body',
    });
  });

  it('เซ็นจาก body ที่ re-serialise แล้ว → ไม่ผ่าน (ต้องใช้ไบต์ดิบเท่านั้น)', () => {
    // parse แล้ว stringify ใหม่: ข้อมูลเหมือนเดิมแต่ไบต์ต่าง (ช่องว่าง/ลำดับ key)
    const reserialised = Buffer.from(JSON.stringify(JSON.parse(RAW.toString()), null, 2));
    const sig = sign(reserialised, TS);
    expect(verifyOmiseSignature(RAW, sig, TS, SECRET_B64, NOW_MS).ok).toBe(false);
  });

  it('secret ไม่ decode base64 ก่อน → ไม่ผ่าน (ของเดิมใช้ค่าดิบเป็น utf8)', () => {
    const wrong = crypto
      .createHmac('sha256', SECRET_B64) // ← ใช้ string ตรง ๆ ไม่ decode
      .update(`${TS}.${RAW.toString('utf8')}`)
      .digest('hex');
    expect(verifyOmiseSignature(RAW, wrong, TS, SECRET_B64, NOW_MS).ok).toBe(false);
  });

  // ── replay ───────────────────────────────────────────────────────────────
  it('timestamp เก่าเกิน tolerance → ปฏิเสธแม้ลายเซ็นถูก (กัน replay)', () => {
    const oldTs = String(Math.floor(NOW_MS / 1000) - OMISE_SIGNATURE_TOLERANCE_SECONDS - 60);
    const sig = sign(RAW, oldTs);
    const verdict = verifyOmiseSignature(RAW, sig, oldTs, SECRET_B64, NOW_MS);
    expect(verdict.ok).toBe(false);
    expect(verdict.ok === false && verdict.reason).toContain('timestamp_out_of_tolerance');
  });

  it('timestamp ในอนาคตไกลเกินไป → ปฏิเสธเช่นกัน', () => {
    const futureTs = String(Math.floor(NOW_MS / 1000) + OMISE_SIGNATURE_TOLERANCE_SECONDS + 60);
    const sig = sign(RAW, futureTs);
    expect(verifyOmiseSignature(RAW, sig, futureTs, SECRET_B64, NOW_MS).ok).toBe(false);
  });

  it('timestamp ที่ไม่ใช่ตัวเลข → ปฏิเสธ', () => {
    expect(verifyOmiseSignature(RAW, sign(RAW, TS), 'not-a-number', SECRET_B64, NOW_MS)).toEqual({
      ok: false,
      reason: 'invalid_timestamp',
    });
  });

  // ── ความทนทาน ────────────────────────────────────────────────────────────
  it('signature ยาวไม่เท่ากัน → ปฏิเสธ ไม่ throw (timingSafeEqual โยน error ถ้าไม่กัน)', () => {
    expect(() =>
      verifyOmiseSignature(RAW, 'abcd', TS, SECRET_B64, NOW_MS),
    ).not.toThrow();
    expect(verifyOmiseSignature(RAW, 'abcd', TS, SECRET_B64, NOW_MS).ok).toBe(false);
  });

  it('signature ที่ไม่ใช่ hex → ปฏิเสธ ไม่ throw', () => {
    expect(verifyOmiseSignature(RAW, 'zzzz!!!!', TS, SECRET_B64, NOW_MS).ok).toBe(false);
  });

  it('body ถูกแก้แม้ไบต์เดียว → ไม่ผ่าน', () => {
    const sig = sign(RAW, TS);
    const tampered = Buffer.from(
      RAW.toString('utf8').replace('recp_test_1', 'recp_test_2'),
      'utf8',
    );
    expect(verifyOmiseSignature(tampered, sig, TS, SECRET_B64, NOW_MS).ok).toBe(false);
  });

  it('secret ว่าง → ปฏิเสธ', () => {
    expect(verifyOmiseSignature(RAW, sign(RAW, TS), TS, '', NOW_MS)).toEqual({
      ok: false,
      reason: 'invalid_secret',
    });
  });
});
