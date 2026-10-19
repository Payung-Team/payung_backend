/**
 * SlidingWindowRateLimiter — ตัวนับ "เรียกไปแล้วกี่ครั้งในช่วง X วินาทีล่าสุด" (PYG-479)
 *
 * ใช้คู่กับ guard ที่ต้องการจำกัดอัตราการเรียก เช่น JoinLinkRateLimitGuard
 * คลาสนี้ไม่รู้จัก NestJS / GraphQL เลย รู้แค่ "key" กับ "เวลา" → เทสได้โดยไม่ต้องบูตอะไร
 *
 * ── ทำไมเขียนเอง ไม่ใช้ @nestjs/throttler ──────────────────────────────────
 *   1. การ์ด PYG-479 ระบุว่าการเพิ่ม dependency ต้องขออนุมัติก่อน
 *   2. throttler ต้องเขียน guard ครอบใหม่อยู่ดีถึงจะใช้กับ GraphQL ได้
 *      และ error ที่มันโยน (ThrottlerException = HttpException) ไม่ได้อยู่ในรูป
 *      `extensions.code` แบบเดียวกับ error ของโมดูล family group ที่ FE อ่านอยู่
 *   3. ของที่ต้องการจริงมีแค่ "นับครั้งต่อ key ในหน้าต่างเวลา" — โค้ดไม่ถึงร้อยบรรทัด
 *
 * ── ทำไมเป็น sliding window ไม่ใช่ fixed window ──────────────────────────
 *   fixed window (นับรีเซ็ตทุกต้นนาที) ปล่อยให้ยิงได้ 2 เท่าของเพดานตรงรอยต่อนาที
 *   เช่น เพดาน 20: ยิง 20 ครั้งตอนวินาทีที่ 59 แล้วอีก 20 ครั้งตอนวินาทีที่ 61 ผ่านหมด
 *   sliding window นับย้อนหลังจาก "ตอนนี้" เสมอ → ภายใน 60 วินาทีใด ๆ ก็ตาม ไม่มีทางเกินเพดาน
 *   เก็บเป็น timestamp ของแต่ละครั้ง (ไม่เกิน limit ตัวต่อ key) จึงกินหน่วยความจำน้อย
 *
 * ⚠ ข้อจำกัดที่ต้องรู้ — ตัวนับอยู่ในหน่วยความจำของ process เดียว
 *   - รีสตาร์ทเซิร์ฟเวอร์ = ตัวนับเริ่มใหม่หมด
 *   - ถ้าวันหนึ่งรันแอปหลาย instance พร้อมกัน แต่ละ instance จะนับแยกกัน
 *     (เพดานจริงจะกลายเป็น limit × จำนวน instance) ตอนนั้นต้องย้ายไปเก็บที่ Redis
 *   ตอนนี้ backend รันเป็น instance เดียวบน Azure (modular monolith) จึงยังเพียงพอ
 */

/** ตัวเลือกของตัวนับ 1 ตัว */
export interface SlidingWindowOptions {
  /** จำนวนครั้งสูงสุดที่ยอมให้ผ่านภายใน 1 หน้าต่างเวลา */
  limit: number;
  /** ความยาวของหน้าต่างเวลา (มิลลิวินาที) */
  windowMs: number;
  /**
   * จำนวน key สูงสุดที่จำไว้พร้อมกัน — กันหน่วยความจำบวมไม่รู้จบ
   *
   * ★ จำเป็นเพราะ key บางชนิด (เช่น IP) ฝั่ง client สร้างใหม่ได้เรื่อย ๆ
   *   ถ้าไม่มีเพดาน คนที่ยิงด้วย key ใหม่ทุกครั้งจะทำให้ Map โตจนเซิร์ฟเวอร์ล่ม
   */
  maxKeys?: number;
}

/** ค่า default ของ maxKeys — 10,000 key × ไม่เกิน limit ตัวเลขต่อ key = ไม่กี่ MB */
export const DEFAULT_MAX_KEYS = 10_000;

export class SlidingWindowRateLimiter {
  /**
   * key → timestamp (ms) ของแต่ละครั้งที่ "ผ่าน" ภายในหน้าต่าง
   * เรียงจากเก่าไปใหม่เสมอ เพราะเราต่อท้าย (push) อย่างเดียว
   */
  private readonly hits = new Map<string, number[]>();

  /** เวลาที่กวาด key ที่หมดอายุทิ้งครั้งล่าสุด (ดู sweepIfDue) */
  private lastSweepAt = 0;

  private readonly maxKeys: number;

  constructor(private readonly options: SlidingWindowOptions) {
    this.maxKeys = options.maxKeys ?? DEFAULT_MAX_KEYS;
  }

  /**
   * ต้องรออีกกี่มิลลิวินาทีถึงจะเรียกได้อีก — 0 = เรียกได้เลย
   *
   * ★ เมธอดนี้ "ไม่นับ" ครั้งนี้ให้ ต้องเรียก record() เองหลังตัดสินใจปล่อยผ่าน
   *   แยกกันแบบนี้เพื่อให้ guard เช็คตัวนับหลายตัว (ผู้ใช้ + IP) ก่อน
   *   แล้วค่อยนับพร้อมกันทีเดียว — ถ้าตัวใดตัวหนึ่งเต็ม ตัวอื่นจะไม่โดนนับฟรี ๆ
   */
  retryAfterMs(key: string, now: number): number {
    const recent = this.recentHits(key, now);
    if (recent.length < this.options.limit) {
      return 0;
    }
    // ช่องว่างจะกลับมา 1 ช่องตอนที่ "ครั้งที่เก่าที่สุด" หลุดออกจากหน้าต่าง
    // recentHits คืนเฉพาะค่าที่ > now - windowMs → ผลลัพธ์ตรงนี้มากกว่า 0 เสมอ
    return recent[0] + this.options.windowMs - now;
  }

  /** นับว่าผ่านไปแล้ว 1 ครั้ง — เรียกหลัง retryAfterMs() คืน 0 เท่านั้น */
  record(key: string, now: number): void {
    this.sweepIfDue(now);

    const recent = this.recentHits(key, now);
    if (!this.hits.has(key)) {
      // key ใหม่ → ต้องมีที่ว่างก่อนเพิ่ม
      this.evictOldestIfFull();
    }
    recent.push(now);
    this.hits.set(key, recent);
  }

  /** จำนวน key ที่จำอยู่ตอนนี้ — มีไว้ให้เทสเช็คว่าหน่วยความจำไม่บวม */
  get trackedKeys(): number {
    return this.hits.size;
  }

  /**
   * timestamp ของ key นี้ที่ยังอยู่ในหน้าต่าง — ตัดตัวที่หมดอายุทิ้งไปด้วยในตัว
   * ถ้าไม่เหลือสักตัว ลบ key ออกจาก Map เลย (key ที่ไม่มีข้อมูลไม่ต้องจำ)
   */
  private recentHits(key: string, now: number): number[] {
    const all = this.hits.get(key);
    if (!all) {
      return [];
    }
    const cutoff = now - this.options.windowMs;
    // เรียงจากเก่าไปใหม่ → หาตัวแรกที่ยังไม่หมดอายุ ตัวก่อนหน้านั้นหมดอายุทั้งหมด
    const firstFresh = all.findIndex((t) => t > cutoff);
    if (firstFresh === -1) {
      this.hits.delete(key);
      return [];
    }
    if (firstFresh > 0) {
      all.splice(0, firstFresh);
    }
    return all;
  }

  /**
   * กวาด key ที่ไม่มีการเรียกในหน้าต่างล่าสุดทิ้ง — ทำอย่างมาก 1 ครั้งต่อ 1 หน้าต่างเวลา
   *
   * ถ้าไม่กวาด ผู้ใช้ที่เรียกครั้งเดียวแล้วไม่กลับมาอีกจะค้างอยู่ใน Map ตลอดไป
   * กวาดทีละรอบใหญ่ (O(จำนวน key)) แค่นาทีละครั้ง ถูกกว่าตั้ง timer แยกต่อ key มาก
   * และไม่ต้องมี setInterval ที่ต้องคอยปิดตอน shutdown / ตอนจบเทส
   */
  private sweepIfDue(now: number): void {
    if (now - this.lastSweepAt < this.options.windowMs) {
      return;
    }
    this.lastSweepAt = now;
    // ลบ entry ระหว่างวนลูป Map ใน JS ปลอดภัย (entry ที่ถูกลบจะไม่ถูกวนถึง)
    for (const key of this.hits.keys()) {
      this.recentHits(key, now);
    }
  }

  /**
   * Map เต็มเพดาน maxKeys → ทิ้ง key ที่ถูกเพิ่มเข้ามาเก่าที่สุด 1 ตัว
   * (Map ของ JS จำลำดับการเพิ่มไว้ให้ → ตัวแรกที่วนเจอคือตัวที่เก่าที่สุด)
   *
   * ผลข้างเคียงที่ยอมรับได้: key ที่ถูกทิ้งจะเริ่มนับใหม่จากศูนย์
   * = ผ่อนการจำกัดให้คนนั้นเล็กน้อย ดีกว่าปล่อยให้หน่วยความจำโตจนเซิร์ฟเวอร์ล่ม
   */
  private evictOldestIfFull(): void {
    if (this.hits.size < this.maxKeys) {
      return;
    }
    // วนแค่รอบเดียวแล้วออก = หยิบตัวแรก (ใช้ for...of แทน .next().value เพราะได้ type string ตรง ๆ)
    for (const oldest of this.hits.keys()) {
      this.hits.delete(oldest);
      break;
    }
  }
}
