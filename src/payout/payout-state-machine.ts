/**
 * PayoutStateMachine — กฎการเปลี่ยนสถานะ payout + audit log (PYG-331 ก้อน B)
 *
 * mirror ทุก aspect ของ PaymentStateMachine (payment module):
 * 1. canTransition(from, to)                        — pure predicate
 * 2. transition(payoutId, target, options, tx?)     — atomic status + history
 * 3. claim(payoutId, from, target, options, tx?)    — race-safe conditional update
 * 4. recordInitialStatus(payoutId, status, opts, tx?) — first row (from=null)
 *
 * ทำไมต้องมี state machine?
 * - payout status ตอน 330 update ตรงจากหลายจุด (worker, service) — status เพี้ยนได้ง่าย
 *   ถ้ามีเงินไปแล้วโดน rollback เป็น scheduled = เงินหาย/โอนซ้ำ
 * - รวมกฎที่เดียว → 331/336/337 เรียกผ่านประตูเดียวกัน มี audit ทุกครั้ง
 *
 * ทำไมต้อง $transaction?
 * - update status + insert history ต้องเกิดพร้อมกัน หรือไม่เกิดเลย
 *   กันสภาพ "status เปลี่ยนแล้วแต่ไม่มี history" หรือ "history มีแต่ status ไม่เปลี่ยน"
 *
 * ทำไมต้องมี claim() แยก transition()?
 * - transition() ทำ read-then-update (SELECT then UPDATE) → race window มี worker คนอื่นแซง
 * - claim() ใช้ conditional UPDATE (updateMany where status=from) → atomic race-safe
 *   เดิม 330 worker ใช้ conditional updateMany แต่ไม่ log history — ก้อน B รวมทั้งสองไว้ในนี้
 */
import { Injectable, NotFoundException } from '@nestjs/common';
import type { Payout, Prisma } from '@prisma/client';
import { PrismaService } from '../common/prisma.service';
import { PayoutStatus } from './entities/payout-status.enum';
import { InvalidPayoutTransitionError } from './errors/invalid-payout-transition.error';

/**
 * ตัวเลือกเสริมตอนเปลี่ยนสถานะ
 * @property changedBy - user id ที่สั่งเปลี่ยน (null = system/worker/reaper)
 * @property reason    - เหตุผลสั้น ๆ เช่น 'omise_transfer_failed', 'stale_processing_reaped'
 * @property metadata  - jsonb เก็บ context เช่น { omiseTransferId, error, nextRetryAt }
 * @property nextRetryAt - ถ้าตั้งมา จะ patch คอลัมน์ payouts.next_retry_at พร้อม status
 * @property extraPayoutFields - patch คอลัมน์อื่นของ payouts พร้อม status (ใน update เดียว)
 *                              เช่น omise_transfer_id ตอน paid, retry_count เพิ่มตอน fail
 */
export type PayoutTransitionOptions = {
  changedBy?: string;
  reason?: string;
  metadata?: Record<string, unknown>;
  nextRetryAt?: Date | null;
  extraPayoutFields?: Prisma.PayoutUpdateInput;
};

/**
 * แผนผัง transition ที่อนุญาต
 * (บังคับด้วย Record<PayoutStatus, ...> — เพิ่ม state ใหม่ใน enum ลืมที่นี่ = TS error)
 *
 * กฎ (จาก brief):
 *   null       → scheduled     (สร้างใหม่ — ไปผ่าน recordInitialStatus ไม่ใช่ transition)
 *   scheduled  → processing    (worker claim)
 *   processing → paid          (Omise สำเร็จ)
 *   processing → scheduled     (Omise fail / reaper — รอ retry รอบถัดไป)
 *   scheduled  → failed        (retry ครบ max)
 *   scheduled  → cancelled     (admin — 336/337)
 *
 * ห้าม (โดยเจตนา):
 *   processing → failed        (ต้องกลับ scheduled ก่อน — retry เป็นคน mark failed)
 *   processing → cancelled     (worker ถือ lock อยู่ — admin ต้องรอ scheduled ก่อน)
 *   paid/failed/cancelled → *  (terminal)
 */
const VALID_TRANSITIONS: Record<PayoutStatus, PayoutStatus[]> = {
  [PayoutStatus.scheduled]: [
    PayoutStatus.processing,
    PayoutStatus.failed,
    PayoutStatus.cancelled,
  ],
  [PayoutStatus.processing]: [PayoutStatus.paid, PayoutStatus.scheduled],
  // ── terminal states ─────────────────────────────────────────────────────
  [PayoutStatus.paid]: [],
  [PayoutStatus.failed]: [],
  [PayoutStatus.cancelled]: [],
};

@Injectable()
export class PayoutStateMachine {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * canTransition — pure predicate (ไม่แตะ DB)
   * false ถ้า from === to หรือ from ไม่อยู่ในแผนผัง
   */
  canTransition(from: PayoutStatus, to: PayoutStatus): boolean {
    return (VALID_TRANSITIONS[from] ?? []).includes(to);
  }

  /**
   * transition — read-then-update: หา current status แล้วเปลี่ยนถ้ากฎอนุญาต
   *
   * ⚠️ ห้ามใช้จาก worker claim path — race window: 2 worker อ่านเจอ 'scheduled'
   *    พร้อมกัน แล้ว update เป็น processing ทั้งคู่ = โอนซ้ำ
   *    ใช้ claim() แทน
   *
   * ใช้ได้ปลอดภัยตอน:
   *  - success path (processing → paid) — ไม่มี race เพราะ worker ยึด id ไว้แล้ว
   *  - failure path (processing → scheduled) — เหมือนกัน
   *  - reaper path (processing → scheduled) — reaper ใช้ conditional guard เอง
   */
  async transition(
    payoutId: string,
    target: PayoutStatus,
    options: PayoutTransitionOptions = {},
    tx?: Prisma.TransactionClient,
  ): Promise<Payout> {
    if (tx) {
      return this.runTransition(tx, payoutId, target, options);
    }
    return this.prisma.$transaction((t) =>
      this.runTransition(t, payoutId, target, options),
    );
  }

  private async runTransition(
    tx: Prisma.TransactionClient,
    payoutId: string,
    target: PayoutStatus,
    options: PayoutTransitionOptions,
  ): Promise<Payout> {
    const payout = await tx.payout.findUnique({ where: { id: payoutId } });
    if (!payout) {
      throw new NotFoundException(`ไม่พบ payout "${payoutId}"`);
    }

    const current = payout.status as PayoutStatus;
    if (!this.canTransition(current, target)) {
      throw new InvalidPayoutTransitionError(current, target);
    }

    // 1) update status (+ optional patch fields, + optional nextRetryAt)
    const updated = await tx.payout.update({
      where: { id: payoutId },
      data: {
        status: target,
        // nextRetryAt: undefined = อย่าแตะ; null = เคลียร์; Date = ตั้งใหม่
        ...(options.nextRetryAt !== undefined
          ? { nextRetryAt: options.nextRetryAt }
          : {}),
        ...(options.extraPayoutFields ?? {}),
      },
    });

    // 2) insert history (atomic)
    await tx.payoutStatusHistory.create({
      data: {
        payoutId,
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
  }

  /**
   * claim — conditional UPDATE race-safe (สำหรับ worker scheduled → processing)
   *
   * มีจุดเด่น 2 อย่างที่ transition() ทำไม่ได้:
   *  1) ตรวจ current status ด้วย WHERE clause ของ UPDATE เอง (atomic กับ read)
   *     ถ้า worker คนอื่นแซง count จะ = 0 (ไม่ error, ไม่ log — คืน false)
   *  2) รับ extraPayoutFields ใน update เดียวกัน (เช่น recipient_id) — 1 statement
   *
   * @returns claimed=true ถ้ายึดได้ (พร้อม payout row + history), false ถ้าเสียการแข่ง
   * @throws  InvalidPayoutTransitionError ถ้า from→target ไม่อยู่ในกฎ
   */
  async claim(
    payoutId: string,
    from: PayoutStatus,
    target: PayoutStatus,
    options: PayoutTransitionOptions = {},
    tx?: Prisma.TransactionClient,
  ): Promise<{ claimed: boolean; payout: Payout | null }> {
    if (!this.canTransition(from, target)) {
      throw new InvalidPayoutTransitionError(from, target);
    }

    if (tx) {
      return this.runClaim(tx, payoutId, from, target, options);
    }
    return this.prisma.$transaction((t) =>
      this.runClaim(t, payoutId, from, target, options),
    );
  }

  private async runClaim(
    tx: Prisma.TransactionClient,
    payoutId: string,
    from: PayoutStatus,
    target: PayoutStatus,
    options: PayoutTransitionOptions,
  ): Promise<{ claimed: boolean; payout: Payout | null }> {
    // updateMany ให้ WHERE รวม status=from → race-safe
    const result = await tx.payout.updateMany({
      where: { id: payoutId, status: from },
      data: {
        status: target,
        ...(options.nextRetryAt !== undefined
          ? { nextRetryAt: options.nextRetryAt }
          : {}),
        ...(options.extraPayoutFields ?? {}),
      },
    });

    if (result.count === 0) {
      // เสียการแข่ง (หรือ payout หายไป / status ไม่ตรง) — ไม่ log history
      return { claimed: false, payout: null };
    }

    // ยึดได้ → log history + คืน row สด
    await tx.payoutStatusHistory.create({
      data: {
        payoutId,
        fromStatus: from,
        toStatus: target,
        changedBy: options.changedBy,
        reason: options.reason,
        metadata:
          options.metadata === undefined
            ? undefined
            : (options.metadata as Prisma.InputJsonValue),
      },
    });

    const fresh = await tx.payout.findUnique({ where: { id: payoutId } });
    return { claimed: true, payout: fresh };
  }

  /**
   * recordInitialStatus — เขียน history แถวแรก (from=null) ตอนสร้าง payout
   *
   * เรียกจาก PayoutService.createFromCompletedBooking — วางไว้ใน $transaction
   * เดียวกับ payout.create เพื่อความ atomic (create + audit ต้องมีคู่กัน)
   */
  async recordInitialStatus(
    payoutId: string,
    status: PayoutStatus,
    options: PayoutTransitionOptions = {},
    tx?: Prisma.TransactionClient,
  ): Promise<void> {
    const client = tx ?? this.prisma;
    await client.payoutStatusHistory.create({
      data: {
        payoutId,
        fromStatus: null, // null = สร้างใหม่ ไม่มี state ก่อนหน้า
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
