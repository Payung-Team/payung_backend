/**
 * PaymentStateMachine — กฎการเปลี่ยนสถานะการชำระเงิน (FSM) + บันทึก audit (PYG-277)
 *
 * หน้าที่:
 * 1. canTransition(from, to)         — ตรวจว่าเปลี่ยนสถานะนี้ได้ไหม (ไม่แตะ DB)
 * 2. transition(paymentId, to, opts) — เปลี่ยนสถานะจริง + เขียน history แบบ atomic
 * 3. recordInitialStatus(...)        — เขียน history แถวแรก (from = null) ตอนสร้าง payment
 *
 * ทำไมต้องมี state machine?
 * - payment มีหลายสถานะ และบางการข้าม "ผิด" (เช่น held → pending, failed → captured)
 *   ถ้าปล่อยให้ service ไหนก็ update paymentStatus ได้ตามใจ → ข้อมูลเพี้ยน/เงินหาย
 * - รวมกฎไว้ที่เดียว → ticket อื่น (PYG-265 hold, PYG-266 capture, PYG-267 refund)
 *   เรียก transition() ผ่านประตูเดียว มั่นใจว่ากฎเดียวกันและมี audit ทุกครั้ง
 *
 * ทำไมต้อง $transaction?
 * - update สถานะ + insert history ต้องเกิดพร้อมกัน ถ้า step ใด step หนึ่งพัง → rollback
 *   กันสภาพ "สถานะเปลี่ยนแล้วแต่ไม่มี history" หรือ "มี history แต่สถานะไม่เปลี่ยน"
 */
import { Injectable, NotFoundException } from '@nestjs/common';
import type { Payment, Prisma } from '@prisma/client';
import { PrismaService } from '../common/prisma.service';
import { PaymentStatus } from './entities/payment-status.enum';
import { InvalidPaymentTransitionError } from './errors/invalid-payment-transition.error';

/**
 * ตัวเลือกเสริมตอนเปลี่ยนสถานะ (ทั้งหมด optional)
 * - param ตัวที่ 3 ของ transition() ตามสเปก ("metadata") ขยายให้ครอบคลุม audit fields
 *
 * @property changedBy - user id ที่สั่งเปลี่ยน (เช่น admin ที่กดคืนเงิน) — ไม่ใส่ = ระบบ/cron
 * @property reason    - เหตุผล เช่น "ผู้ป่วยยกเลิกก่อนวันบริการ"
 * @property metadata  - ข้อมูลเสริม เก็บลง jsonb เช่น { omiseChargeId, refundAmount }
 */
export type TransitionOptions = {
  changedBy?: string;
  reason?: string;
  metadata?: Record<string, unknown>;
};

/**
 * แผนผังการเปลี่ยนสถานะที่ "อนุญาต" — key = สถานะปัจจุบัน, value = สถานะปลายทางที่ไปได้
 *
 * ใช้ Record<PaymentStatus, ...> เพื่อบังคับให้ระบุครบทุกสถานะ
 * (ถ้าเพิ่มสถานะใหม่ใน enum แต่ลืมเพิ่มที่นี่ → TypeScript ฟ้อง compile error)
 *
 * สถานะปลายทาง (transferred/voided/refunded/...) เป็น terminal → ไปต่อไม่ได้ ([])
 */
const VALID_TRANSITIONS: Record<PaymentStatus, PaymentStatus[]> = {
  [PaymentStatus.pending]: [PaymentStatus.held, PaymentStatus.failed],
  [PaymentStatus.held]: [
    PaymentStatus.captured,
    PaymentStatus.voided,
    PaymentStatus.expired,
  ],
  [PaymentStatus.captured]: [
    PaymentStatus.transferred,
    PaymentStatus.refunded,
    PaymentStatus.partially_refunded,
  ],
  // ── terminal states: เปลี่ยนต่อไม่ได้ ─────────────────────────────────────
  [PaymentStatus.transferred]: [],
  [PaymentStatus.voided]: [],
  [PaymentStatus.refunded]: [],
  [PaymentStatus.partially_refunded]: [],
  [PaymentStatus.failed]: [],
  [PaymentStatus.expired]: [],
};

@Injectable()
export class PaymentStateMachine {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * canTransition — ตรวจว่าเปลี่ยนจาก `from` ไป `to` ได้ไหม (pure, ไม่แตะ DB)
   *
   * @returns true ถ้าอนุญาต, false ถ้าไม่อนุญาต (รวมถึงกรณี from === to)
   */
  canTransition(from: PaymentStatus, to: PaymentStatus): boolean {
    // ?? [] กันกรณี from เป็นค่าที่ไม่อยู่ในแผนผัง (เช่น string แปลกปลอม)
    return (VALID_TRANSITIONS[from] ?? []).includes(to);
  }

  /**
   * transition — เปลี่ยนสถานะ payment จริง + เขียน audit history (atomic)
   *
   * ขั้นตอน:
   *  1) โหลด payment (ใน transaction) → ไม่เจอ → NotFoundException
   *  2) เช็คกฎ canTransition(current → target) → ผิด → InvalidPaymentTransitionError
   *  3) update payments.payment_status + updated_at
   *  4) insert payment_status_history 1 แถว
   *
   * @param paymentId - UUID ของ payment
   * @param target    - สถานะปลายทางที่ต้องการเปลี่ยนไป
   * @param options   - { changedBy?, reason?, metadata? } (ดู TransitionOptions)
   * @returns Payment ที่อัปเดตสถานะแล้ว
   * @throws NotFoundException              ถ้าไม่พบ payment
   * @throws InvalidPaymentTransitionError  ถ้าการเปลี่ยนสถานะผิดกฎ FSM
   */
  async transition(
    paymentId: string,
    target: PaymentStatus,
    options: TransitionOptions = {},
  ): Promise<Payment> {
    return this.prisma.$transaction(async (tx) => {
      const payment = await tx.payment.findUnique({ where: { id: paymentId } });

      if (!payment) {
        throw new NotFoundException(`ไม่พบ payment "${paymentId}"`);
      }

      // Prisma คืน paymentStatus เป็น string-union → cast เป็น local enum (ค่าเดียวกัน)
      const current = payment.paymentStatus as PaymentStatus;

      if (!this.canTransition(current, target)) {
        throw new InvalidPaymentTransitionError(current, target);
      }

      // 1) อัปเดตสถานะบน payment
      const updated = await tx.payment.update({
        where: { id: paymentId },
        data: { paymentStatus: target, updatedAt: new Date() },
      });

      // 2) เขียน history (audit) — from = สถานะเดิม, to = สถานะใหม่
      await tx.paymentStatusHistory.create({
        data: {
          paymentId,
          fromStatus: current,
          toStatus: target,
          changedBy: options.changedBy,
          reason: options.reason,
          metadata:
            options.metadata === undefined
              ? undefined
              : (options.metadata as Prisma.InputJsonValue),
        },
      });

      return updated;
    });
  }

  /**
   * recordInitialStatus — เขียน history แถวแรกตอน "สร้าง" payment (from = null)
   *
   * ใช้โดย PYG-264 (createPayment): หลังสร้าง payment สถานะ pending แล้ว
   * เรียกเมธอดนี้เพื่อให้ timeline ของ payment เริ่มต้นครบตั้งแต่แถวแรก
   *
   * แยกจาก transition() เพราะตอนสร้างยังไม่มี "สถานะก่อนหน้า" ให้ตรวจกฎ
   *
   * @param paymentId - UUID ของ payment ที่เพิ่งสร้าง
   * @param status    - สถานะเริ่มต้น (ปกติคือ pending)
   * @param options   - { changedBy?, reason?, metadata? }
   */
  async recordInitialStatus(
    paymentId: string,
    status: PaymentStatus,
    options: TransitionOptions = {},
  ): Promise<void> {
    await this.prisma.paymentStatusHistory.create({
      data: {
        paymentId,
        fromStatus: null, // null = ไม่มีสถานะก่อนหน้า (เป็นการสร้างใหม่)
        toStatus: status,
        changedBy: options.changedBy,
        reason: options.reason,
        metadata:
          options.metadata === undefined
            ? undefined
            : (options.metadata as Prisma.InputJsonValue),
      },
    });
  }
}
