/**
 * Unit tests — SlidingWindowRateLimiter (PYG-479)
 *
 * คลาสนี้รับเวลาเป็นพารามิเตอร์ (now) → คุมเวลาได้เป๊ะโดยไม่ต้องรอจริงหรือ mock นาฬิกา
 * ทุกเคสใช้เพดาน 3 ครั้ง / 1,000 ms เพื่อให้ตัวเลขอ่านง่าย
 */
import { SlidingWindowRateLimiter } from './sliding-window-rate-limiter';

const LIMIT = 3;
const WINDOW_MS = 1_000;

/** เรียก "เช็คแล้วนับ" แบบที่ guard ทำ — คืน true ถ้าผ่าน */
function attempt(limiter: SlidingWindowRateLimiter, key: string, now: number) {
  if (limiter.retryAfterMs(key, now) > 0) return false;
  limiter.record(key, now);
  return true;
}

describe('SlidingWindowRateLimiter (PYG-479)', () => {
  let limiter: SlidingWindowRateLimiter;

  beforeEach(() => {
    limiter = new SlidingWindowRateLimiter({
      limit: LIMIT,
      windowMs: WINDOW_MS,
    });
  });

  it('ปล่อยผ่านได้ครบเพดานพอดี แล้วปฏิเสธครั้งถัดไป', () => {
    expect([0, 1, 2, 3].map((t) => attempt(limiter, 'u1', t))).toEqual([
      true,
      true,
      true,
      false,
    ]);
  });

  it('บอกเวลารอได้ตรง = ตอนที่ครั้งเก่าสุดหลุดออกจากหน้าต่าง', () => {
    [100, 200, 300].forEach((t) => limiter.record('u1', t));

    // ครั้งแรกเกิดที่ 100 → หลุดหน้าต่างที่ 1,100 → ถามตอน 400 ต้องรออีก 700
    expect(limiter.retryAfterMs('u1', 400)).toBe(700);
  });

  it('sliding window — ครบหน้าต่างของครั้งเก่าสุดแล้วได้ช่องคืนมาทีละช่อง ไม่ใช่รีเซ็ตทั้งหมด', () => {
    [0, 500, 900].forEach((t) => limiter.record('u1', t));

    // ที่ 1,000 ครั้งแรก (0) พ้นหน้าต่างพอดี → ว่าง 1 ช่อง
    expect(attempt(limiter, 'u1', 1_000)).toBe(true);
    // ช่องเดียวที่ว่างถูกใช้ไปแล้ว → ครั้งถัดไปยังต้องรอ (500 ยังไม่หลุด)
    expect(attempt(limiter, 'u1', 1_001)).toBe(false);
    expect(limiter.retryAfterMs('u1', 1_001)).toBe(499);
  });

  it('ไม่ยอมให้ยิงเบิ้ลตรงรอยต่อหน้าต่าง (จุดอ่อนของ fixed window)', () => {
    // ยิงเต็มเพดานช่วงท้ายหน้าต่างแรก
    [990, 995, 999].forEach((t) =>
      expect(attempt(limiter, 'u1', t)).toBe(true),
    );
    // ต้นหน้าต่างถัดไปทันที — fixed window จะปล่อยอีก 3 ครั้ง แต่ sliding ต้องไม่ปล่อย
    expect(attempt(limiter, 'u1', 1_001)).toBe(false);
  });

  it('ครั้งที่ถูกปฏิเสธไม่ถูกนับ — กดซ้ำระหว่างรอไม่ทำให้เวลารอยืดออก', () => {
    [0, 1, 2].forEach((t) => limiter.record('u1', t));
    for (let t = 3; t < 1_000; t += 50) {
      expect(attempt(limiter, 'u1', t)).toBe(false);
    }
    // ถ้าครั้งที่ถูกปฏิเสธถูกนับด้วย ตรงนี้จะยังเต็มอยู่
    expect(attempt(limiter, 'u1', 1_000)).toBe(true);
  });

  it('แต่ละ key นับแยกกัน — คนหนึ่งเต็มไม่กระทบอีกคน', () => {
    [0, 1, 2].forEach((t) => limiter.record('u1', t));

    expect(limiter.retryAfterMs('u1', 3)).toBeGreaterThan(0);
    expect(limiter.retryAfterMs('u2', 3)).toBe(0);
  });

  it('key ที่ไม่มีการเรียกเกินหนึ่งหน้าต่างถูกกวาดทิ้ง (หน่วยความจำไม่ค้าง)', () => {
    limiter.record('old-1', 0);
    limiter.record('old-2', 0);
    expect(limiter.trackedKeys).toBe(2);

    // ผ่านไปเกินหนึ่งหน้าต่าง การเรียกครั้งถัดไปจะกวาด key เก่าทิ้ง
    limiter.record('new', 2 * WINDOW_MS);

    expect(limiter.trackedKeys).toBe(1);
  });

  it('เพดาน maxKeys — key ใหม่เบียด key ที่เก่าที่สุดออก จำนวน key ไม่เกินเพดาน', () => {
    const small = new SlidingWindowRateLimiter({
      limit: LIMIT,
      windowMs: WINDOW_MS,
      maxKeys: 2,
    });
    small.record('a', 0);
    small.record('a', 1);
    small.record('a', 2); // a เต็มแล้ว
    small.record('b', 3);
    small.record('c', 4); // เพดาน 2 → a (เก่าสุด) ถูกทิ้ง

    expect(small.trackedKeys).toBe(2);
    // a ถูกลืมไปแล้ว = เริ่มนับใหม่ (ผลข้างเคียงที่ยอมรับได้ ดีกว่าหน่วยความจำบวม)
    expect(small.retryAfterMs('a', 5)).toBe(0);
  });

  it('ยิงด้วย key ใหม่ทุกครั้ง (เช่น ปลอม IP) จำนวน key ก็ไม่เกินเพดาน', () => {
    const small = new SlidingWindowRateLimiter({
      limit: LIMIT,
      windowMs: WINDOW_MS,
      maxKeys: 100,
    });
    // 1,000 key ภายในหน้าต่างเดียว (เวลา 0–999 ms) → การกวาดช่วยไม่ได้ ต้องพึ่งเพดานล้วน ๆ
    for (let i = 0; i < 1_000; i++) {
      small.record(`spoofed-${i}`, i);
    }
    expect(small.trackedKeys).toBeLessThanOrEqual(100);
  });
});
