/**
 * PayoutRetryPolicy — exponential backoff (PYG-331 ก้อน B)
 *
 * env:
 *   PAYOUT_MAX_RETRIES=5
 *   PAYOUT_BACKOFF_MINUTES=10,30,60,180,360   (comma-separated ints, ต้องยาว ≥ MAX)
 *
 * รูปแบบการตัดสินหลัง Omise fail:
 *   retryCountBefore = จำนวนที่ล้มไปแล้ว (0 = ยังไม่เคยล้ม, เพิ่งล้มครั้งแรก)
 *   retryCountAfter  = retryCountBefore + 1
 *   ถ้า retryCountAfter < MAX_RETRIES → schedule retry:
 *      next_retry_at = now() + BACKOFF_MINUTES[retryCountAfter - 1]
 *      status back to 'scheduled'
 *   ถ้า retryCountAfter >= MAX_RETRIES → terminate:
 *      status → 'failed', next_retry_at = null
 *
 * ทำไม comma-list ไม่ใช่สูตร?
 *   ทีมอ่านง่าย ปรับได้ต่อ env ไม่ต้อง redeploy โค้ด
 *   ถ้าอนาคตต้องการสูตร exponential 2^n ค่อยแทนที่ config นี้
 */
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

export type RetryDecision =
  | {
      kind: 'retry';
      nextRetryAt: Date;
      /** จำนวน retry หลังเพิ่ม (= ค่าที่จะเขียนลง payouts.retry_count) */
      newRetryCount: number;
      /** delay เป็นนาที (สำหรับ log + audit metadata) */
      backoffMinutes: number;
    }
  | {
      kind: 'terminate';
      /** จำนวน retry หลังเพิ่ม */
      newRetryCount: number;
    };

@Injectable()
export class PayoutRetryPolicy {
  constructor(private readonly config: ConfigService) {}

  /**
   * decide — คำนวณว่าหลัง fail 1 ครั้งต่อจากนี้ ต้องทำอย่างไร
   *
   * @param retryCountBefore  ค่าปัจจุบันของ payouts.retry_count (ก่อนบวก 1)
   * @param now               (test-friendly) เวลาที่ใช้เป็น anchor — default new Date()
   */
  decide(retryCountBefore: number, now: Date = new Date()): RetryDecision {
    const maxRetries = this.readMaxRetries();
    const backoffs = this.readBackoffMinutes();

    const newRetryCount = retryCountBefore + 1;

    // ตัวอย่าง: MAX=5, retryCountBefore=4 (เคยล้ม 4 ครั้ง, กำลังล้มครั้งที่ 5)
    //   newRetryCount = 5 → >= MAX → terminate
    if (newRetryCount >= maxRetries) {
      return { kind: 'terminate', newRetryCount };
    }

    // backoffs index = newRetryCount - 1 (retry ครั้งที่ 1 ใช้ backoffs[0])
    const idx = newRetryCount - 1;
    if (idx >= backoffs.length) {
      throw new Error(
        `PAYOUT_BACKOFF_MINUTES has ${backoffs.length} entries but retry attempt ${newRetryCount} needs index ${idx}. ` +
          `MAX_RETRIES=${maxRetries}: config PAYOUT_BACKOFF_MINUTES ต้องมีอย่างน้อย MAX_RETRIES-1 = ${maxRetries - 1} ตัว`,
      );
    }
    const backoffMinutes = backoffs[idx];
    const nextRetryAt = new Date(now.getTime() + backoffMinutes * 60 * 1000);
    return { kind: 'retry', nextRetryAt, newRetryCount, backoffMinutes };
  }

  private readMaxRetries(): number {
    const raw = this.config.getOrThrow<string>('PAYOUT_MAX_RETRIES');
    const n = Number(raw);
    if (!Number.isInteger(n) || n < 1) {
      throw new Error(
        `PAYOUT_MAX_RETRIES must be a positive integer, got "${raw}"`,
      );
    }
    return n;
  }

  private readBackoffMinutes(): number[] {
    const raw = this.config.getOrThrow<string>('PAYOUT_BACKOFF_MINUTES');
    const parts = raw.split(',').map((s) => s.trim()).filter(Boolean);
    if (parts.length === 0) {
      throw new Error('PAYOUT_BACKOFF_MINUTES is empty');
    }
    const nums = parts.map((s) => Number(s));
    for (let i = 0; i < nums.length; i++) {
      if (!Number.isInteger(nums[i]) || nums[i] < 0) {
        throw new Error(
          `PAYOUT_BACKOFF_MINUTES[${i}] must be non-negative integer, got "${parts[i]}"`,
        );
      }
    }
    return nums;
  }
}
