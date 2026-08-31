/**
 * PayoutWorkerService — PYG-330 + PYG-331 (ก้อน B)
 *
 * @Cron ทุก 10 นาที: หา payouts ที่ถึงกำหนดโอนเงินผ่าน Omise
 *
 * ต่างจากรุ่น 330 อย่างไร (ก้อน B refactor):
 *   1. ทุก status transition ผ่าน PayoutStateMachine (ไม่มี raw payout.update อีก)
 *      → มี audit history ทุกจุด, กันการข้าม state ที่ผิดกฎ
 *   2. worker query เพิ่ม backoff guard next_retry_at (แทนที่จะยิงรัวทุก 10 นาที)
 *   3. failure → PayoutRetryPolicy ตัดสินว่าจะ retry หรือ terminate ('failed')
 *      รอบก่อนหน้าจะกลับ 'scheduled' + retry_count++ เสมอ = ไม่ backoff จริง (แก้แล้ว)
 *   4. kill-switch env — skip ทั้งรอบถ้า enable
 *
 * ลำดับต่อ 1 payout (Sam-approved order):
 *   1) READ CaregiverPayoutAccount ก่อน — recipient ยังไม่พร้อม → skip ไม่แตะ row
 *      (กัน churn ทุก 10 นาที × 7 วัน)
 *   2) CLAIM ผ่าน stateMachine.claim(scheduled → processing) = conditional UPDATE
 *      + history log ใน tx เดียว (race-safe)
 *   3) Omise createTransfer(satangs, recipientId, `payout:${payout.id}`)
 *      idempotency key คงที่ต่อ payout — retry ยิงซ้ำ Omise dedup ได้
 *   4a) success → stateMachine.transition(processing → paid, {omise_transfer_id, processed_at})
 *              + NotificationService.create(payment_transferred)
 *   4b) failure → PayoutRetryPolicy.decide(retry_count)
 *              retry: transition(processing → scheduled, {retry_count++, next_retry_at})
 *              terminate: transition(processing → scheduled, {retry_count++, next_retry_at=null})
 *                     แล้ว transition(scheduled → failed, {reason=max_retries_exceeded})
 *                     ทำใน tx เดียว
 */
import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../common/prisma.service';
import { OmiseService } from '../payment/omise/omise.service';
import { NotificationService } from '../notification/notification.service';
import { NotificationType } from '../notification/entities/notification-type.enum';
import { PayoutStateMachine } from './payout-state-machine';
import { PayoutStatus } from './entities/payout-status.enum';
import { PayoutRetryPolicy } from './payout-retry-policy';
import { PayoutKillswitch } from './payout-killswitch';
import { PayoutEligibilityService } from './payout-eligibility.service';

@Injectable()
export class PayoutWorkerService {
  private readonly logger = new Logger(PayoutWorkerService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly omise: OmiseService,
    private readonly notifications: NotificationService,
    private readonly stateMachine: PayoutStateMachine,
    private readonly retryPolicy: PayoutRetryPolicy,
    private readonly killswitch: PayoutKillswitch,
    private readonly eligibility: PayoutEligibilityService,
  ) {}

  @Cron(CronExpression.EVERY_10_MINUTES)
  async run(): Promise<void> {
    if (this.killswitch.gate('PayoutWorker')) return;

    const now = new Date();
    // PYG-331 backoff guard: skip payout ที่โดน delay เพราะเพิ่งล้ม
    const due = await this.prisma.payout.findMany({
      where: {
        status: PayoutStatus.scheduled,
        scheduledAt: { lte: now },
        OR: [{ nextRetryAt: null }, { nextRetryAt: { lte: now } }],
      },
      // ใช้ index (status, scheduled_at); nextRetryAt ตัวกรองรอง
    });

    if (due.length === 0) {
      this.logger.debug('[PayoutWorker] no due payouts');
      return;
    }

    this.logger.log(`[PayoutWorker] processing ${due.length} due payout(s)`);

    for (const payout of due) {
      try {
        await this.processOne(payout.id);
      } catch (err) {
        // isolate errors per payout — 1 ใบพัง ไม่กระทบใบอื่น
        const msg = err instanceof Error ? err.message : String(err);
        this.logger.error(
          `[PayoutWorker] uncaught error payout=${payout.id}: ${msg}`,
        );
      }
    }
  }

  /**
   * processOne — flow 1 payout
   * แยก method เพื่อให้ test ยิงตรงเข้ามาได้
   */
  async processOne(payoutId: string): Promise<void> {
    // ── Step 1: READ recipient ก่อน claim (ห้ามแตะ row ถ้ายังไม่พร้อม) ──────
    const payout = await this.prisma.payout.findUnique({
      where: { id: payoutId },
      select: {
        id: true,
        status: true,
        bookingId: true,
        caregiverId: true,
        amount: true,
        retryCount: true,
        caregiver: {
          select: {
            userId: true,
            payoutAccount: {
              select: {
                omiseRecipientId: true,
                recipientStatus: true,
              },
            },
          },
        },
      },
    });

    if (!payout) {
      this.logger.warn(`[PayoutWorker] payout ${payoutId} not found`);
      return;
    }

    // sanity — payout ควรเป็น scheduled (query กรองแล้ว) — ระหว่าง loop worker อื่นอาจแซง
    if (payout.status !== PayoutStatus.scheduled) {
      this.logger.debug(
        `[PayoutWorker] payout ${payoutId} no longer scheduled (${payout.status}) — skipping`,
      );
      return;
    }

    // ── Step 1b: RE-CHECK ก่อนโอนจริง ───────────────────────────────────────
    // ⚠️ ต้องเช็คซ้ำถึงแม้ตอนสร้าง payout จะเช็คไปแล้ว:
    //    payout ถูกสร้างตอน booking completed แต่ worker โอนอีก 7 วันให้หลัง
    //    (PAYOUT_HOLD_WINDOW_DAYS) — patient มีเวลาทั้งสัปดาห์ที่จะ flag dispute
    //    เช็คก่อน claim/ก่อนอ่าน recipient เพราะนี่คือประตูเงิน ไม่ใช่เรื่อง config ปลายทาง
    // ⚠️ ห้ามโอนก่อนแล้วค่อยแก้ทีหลัง — Omise transfer ย้อนกลับเองไม่ได้
    const verdict = await this.eligibility.check(payout.bookingId);

    if (verdict.kind === 'hold') {
      // ห้ามแตะ row (ไม่ claim / ไม่เขียน history) — เหมือน pattern recipient-not-ready
      // ปล่อยค้างที่ scheduled: ถ้า admin ตัดสิน no_refund รอบหน้าจะไหลต่อเอง
      this.logger.warn(
        `[PayoutWorker] hold payout=${payoutId} booking=${payout.bookingId} — ` +
          `${verdict.reason} (evidence=${JSON.stringify(verdict.evidence)}) — not transferring`,
      );
      return;
    }

    if (verdict.kind === 'deny') {
      // ปิดตาย: scheduled → cancelled ผ่าน state machine (claim = conditional update
      // กัน race กับ worker ตัวอื่นที่อาจ claim เป็น processing ไปแล้ว)
      const cancelled = await this.stateMachine.claim(
        payoutId,
        PayoutStatus.scheduled,
        PayoutStatus.cancelled,
        {
          reason: `payout_gate_denied:${verdict.reason}`,
          metadata: { ...verdict.evidence, deniedAt: new Date().toISOString() },
        },
      );
      this.logger.error(
        `[PayoutWorker] cancelled payout=${payoutId} booking=${payout.bookingId} — ` +
          `${verdict.reason} (claimed=${cancelled.claimed})`,
      );
      return;
    }

    const account = payout.caregiver?.payoutAccount;
    const recipientId = account?.omiseRecipientId ?? null;
    const recipientStatus = account?.recipientStatus ?? null;

    if (!recipientId || recipientStatus !== 'verified') {
      // ห้าม claim / ห้ามแตะ row / ห้าม log ประวัติ
      // caregiver จะมา verify ผ่าน PYG-307 → payout ยัง scheduled รอต่อ
      this.logger.warn(
        `[PayoutWorker] skip payout=${payoutId} — recipient not ready ` +
          `(recipient_id=${recipientId ?? 'null'}, recipient_status=${recipientStatus ?? 'null'})`,
      );
      return;
    }

    // ── Step 2: CLAIM ผ่าน state machine (conditional UPDATE + history atomic) ──
    const claim = await this.stateMachine.claim(
      payoutId,
      PayoutStatus.scheduled,
      PayoutStatus.processing,
      {
        reason: 'worker_claim',
        metadata: { recipientId },
        extraPayoutFields: { recipientId },
      },
    );

    if (!claim.claimed) {
      this.logger.debug(
        `[PayoutWorker] payout ${payoutId} already claimed by another worker`,
      );
      return;
    }

    this.logger.log(
      `[PayoutWorker] claimed payout=${payoutId} recipient=${recipientId}`,
    );

    // ── Step 3: Omise createTransfer ───────────────────────────────────────
    const amountDecimal = payout.amount as unknown as Prisma.Decimal;
    const amountSatangs = amountDecimal
      .mul(100)
      .toDecimalPlaces(0, Prisma.Decimal.ROUND_HALF_UP)
      .toNumber();

    // idempotency key คงที่ต่อ payout — retry ยิงซ้ำ Omise dedup ได้
    const idempotencyKey = `payout:${payout.id}`;

    let transfer: Awaited<ReturnType<typeof this.omise.createTransfer>>;
    try {
      transfer = await this.omise.createTransfer(
        amountSatangs,
        recipientId,
        idempotencyKey,
      );
    } catch (transferErr) {
      // ── Step 4b: failure path — retry policy ตัดสิน ──────────────────────
      await this.handleTransferFailure(payoutId, payout.retryCount, transferErr);
      return; // for-loop ใน run() ทำ payout ถัดไป
    }

    // ── Step 4a: success → paid + notification ──────────────────────────────
    await this.stateMachine.transition(
      payoutId,
      PayoutStatus.paid,
      {
        reason: 'omise_transfer_success',
        metadata: {
          omiseTransferId: transfer.id,
          omiseStatus: transfer.status,
          amountSatangs,
        },
        // เคลียร์ next_retry_at (เผื่อรอบก่อนเคยตั้งไว้จาก retry)
        nextRetryAt: null,
        extraPayoutFields: {
          omiseTransferId: transfer.id,
          processedAt: new Date(),
        },
      },
    );

    this.logger.log(
      `[PayoutWorker] paid payout=${payoutId} transferId=${transfer.id} amountSth=${amountSatangs}`,
    );

    // in-app notification ตรง ๆ (ไม่มี event/listener กลาง — ตาม 330 pattern)
    const caregiverUserId = payout.caregiver?.userId;
    if (caregiverUserId) {
      try {
        await this.notifications.create(
          caregiverUserId,
          NotificationType.payment_transferred,
          'ค่าตอบแทนโอนแล้ว',
          `เราได้โอนค่าตอบแทน ${amountDecimal.toString()} บาท เข้าบัญชีของคุณแล้ว`,
          {
            payoutId: payout.id,
            bookingId: payout.bookingId,
            amount: amountDecimal.toString(),
            omiseTransferId: transfer.id,
          },
        );
      } catch (notifyErr) {
        // notification พังห้ามทำให้ payout ที่โอนสำเร็จแล้ว rollback
        const msg =
          notifyErr instanceof Error ? notifyErr.message : String(notifyErr);
        this.logger.error(
          `[PayoutWorker] notification failed payout=${payoutId}: ${msg}`,
        );
      }
    } else {
      this.logger.warn(
        `[PayoutWorker] payout=${payoutId} caregiver has no userId — cannot notify`,
      );
    }
  }

  /**
   * handleTransferFailure — เรียกจาก processOne เมื่อ Omise ล้ม
   *
   * ตัดสินใจตาม PayoutRetryPolicy:
   *   retry (retry_count+1 < MAX) → processing → scheduled พร้อม next_retry_at
   *   terminate (retry_count+1 >= MAX) → processing → scheduled → failed
   *     (ต้องผ่าน scheduled ก่อน เพราะ processing → failed ตรงเป็น transition ที่ห้ามตามกฎ)
   *     ทำใน $transaction เดียวเพื่อไม่ให้ค้างที่ scheduled ระหว่างทาง
   */
  private async handleTransferFailure(
    payoutId: string,
    retryCountBefore: number,
    err: unknown,
  ): Promise<void> {
    const msg = err instanceof Error ? err.message : String(err);
    this.logger.error(
      `[PayoutWorker] Omise transfer failed payout=${payoutId}: ${msg}`,
    );

    const decision = this.retryPolicy.decide(retryCountBefore);

    if (decision.kind === 'retry') {
      // processing → scheduled + retry_count++ + next_retry_at
      await this.stateMachine.transition(payoutId, PayoutStatus.scheduled, {
        reason: 'omise_transfer_failed_retry',
        metadata: {
          error: msg,
          newRetryCount: decision.newRetryCount,
          backoffMinutes: decision.backoffMinutes,
          nextRetryAt: decision.nextRetryAt.toISOString(),
        },
        nextRetryAt: decision.nextRetryAt,
        extraPayoutFields: { retryCount: { increment: 1 } },
      });
      return;
    }

    // terminate: processing → scheduled → failed ใน tx เดียว
    // (transition matrix ไม่มี processing → failed ตรง ๆ ตามเจตนา)
    await this.prisma.$transaction(async (tx) => {
      await this.stateMachine.transition(
        payoutId,
        PayoutStatus.scheduled,
        {
          reason: 'omise_transfer_failed_final_before_terminate',
          metadata: { error: msg, newRetryCount: decision.newRetryCount },
          nextRetryAt: null,
          extraPayoutFields: { retryCount: { increment: 1 } },
        },
        tx,
      );
      await this.stateMachine.transition(
        payoutId,
        PayoutStatus.failed,
        {
          reason: 'max_retries_exceeded',
          metadata: { error: msg, retryCount: decision.newRetryCount },
        },
        tx,
      );
    });

    this.logger.error(
      `[PayoutWorker] payout=${payoutId} exhausted retries → failed (retry_count=${decision.newRetryCount})`,
    );
    // Note: ไม่ส่ง notification ให้ caregiver ตอน failed —
    // TS NotificationType enum ไม่มีค่าที่เหมาะ (payment_transferred = success only)
    // เขียนใน PR ว่าเลือกทางนี้ (log-only) รอ 336/337 เพิ่ม admin UI แทน
  }
}
