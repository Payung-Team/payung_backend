import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { ConfigService } from '@nestjs/config';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { PrismaService } from '../common/prisma.service';
import { OmiseService } from './omise/omise.service';
import { PaymentStateMachine } from './payment-state-machine';
import { PaymentStatus } from './entities/payment-status.enum';
import { IdempotencyService } from './idempotency.service';

/**
 * PYG-4xx kill-switch ของ hold-refresh — ★ fail-closed: ไม่ตั้ง = ไม่ทำงาน
 *
 * ทิศเดียวกับ BOOKING_EXPIRY_CRON_ENABLED (ต้องตั้งเองถึงจะเดิน) ไม่ใช่ PAYOUT_KILLSWITCH_ENABLED
 * (ที่ไม่ตั้ง = เดิน) — cron ตัวนี้ยิงธุรกรรมจริงบนบัตรผู้ใช้โดยผู้ใช้ไม่ได้สั่ง ค่า default
 * จึงต้องเป็น "ไม่ทำ" เสมอ
 */
export const HOLD_REFRESH_ENABLED_ENV = 'HOLD_REFRESH_CRON_ENABLED';

/** เพดานใบต่อรอบ — แพทเทิร์นเดียวกับ EXPIRY_BATCH_CAP (booking-expiry) / SWEEP_BATCH_CAP (no-checkout-sweeper) */
export const HOLD_REFRESH_BATCH_CAP = 50;

@Injectable()
export class PaymentCronService {
  private readonly logger = new Logger(PaymentCronService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly omise: OmiseService,
    private readonly fsm: PaymentStateMachine,
    private readonly eventEmitter: EventEmitter2,
    private readonly config: ConfigService,
    private readonly idempotency: IdempotencyService,
  ) {}

  /**
   * PYG-4xx: หา timestamp ของ "การเข้าสถานะ held ครั้งล่าสุด" จาก payment_status_history
   *
   * ★ ทำไมต้องดูจาก history แทน payment.createdAt ตรงๆ: หลังจาก refreshExpiringHolds()
   *   ต่ออายุวงเงินให้แล้ว (void ของเดิม + authorize ใหม่) แถว payment ยังเป็น row เดิม —
   *   createdAt ไม่เปลี่ยน แต่ "อายุของ hold ปัจจุบัน" ต้องนับใหม่จากตอนต่ออายุ ไม่ใช่ตอนสร้าง
   *   booking ครั้งแรก ถ้ายังอิง createdAt คู่นี้จะกัดกันเอง: refresh ต่ออายุไปวันนี้
   *   พรุ่งนี้ cron นี้ (อิง createdAt เดิม) จะมาปิดวงเงินที่เพิ่งต่อทันที
   *
   * fallback เป็น payment.createdAt ถ้าหา history ไม่เจอ (ไม่ควรเกิด — ทุก payment ที่เคย
   * held ต้องมีแถว toStatus=held อย่างน้อย 1 แถวเสมอ กันไว้เผื่อข้อมูลเก่าก่อนมี history)
   */
  private async getHeldSince(paymentId: string, fallback: Date): Promise<Date> {
    const latest = await this.prisma.paymentStatusHistory.findFirst({
      where: { paymentId, toStatus: PaymentStatus.held },
      orderBy: { createdAt: 'desc' },
      select: { createdAt: true },
    });
    return latest?.createdAt ?? fallback;
  }

  /**
   * true เฉพาะเมื่อตั้ง HOLD_REFRESH_CRON_ENABLED เป็น true / 1 / yes
   * (parse แบบเดียวกับ PayoutKillswitch.isEnabled / BookingExpiryService.isEnabled)
   */
  private isHoldRefreshEnabled(): boolean {
    const raw = (this.config.get<string>(HOLD_REFRESH_ENABLED_ENV) ?? '')
      .trim()
      .toLowerCase();
    return raw === 'true' || raw === '1' || raw === 'yes';
  }

  @Cron(CronExpression.EVERY_DAY_AT_2AM)
  async handleExpiredHolds(): Promise<void> {
    this.logger.log('Running expired holds cron job...');

    const holdDays = Number(this.config.get('PAYMENT_HOLD_DAYS', 7));
    const expiryDate = new Date();
    expiryDate.setDate(expiryDate.getDate() - holdDays);

    // ★ ดึง held ทั้งหมดมาก่อน แล้วกรองด้วย "held-since จริง" (ดู getHeldSince ด้านบน) —
    //   กรองด้วย payment.createdAt ตรงๆ ในชั้น DB ไม่ได้อีกต่อไป เพราะ hold ที่ถูก
    //   refreshExpiringHolds() ต่ออายุแล้วต้องนับอายุใหม่จากตอนต่ออายุ ไม่ใช่ตอนสร้าง booking
    const heldPayments = await this.prisma.payment.findMany({
      where: { paymentStatus: PaymentStatus.held },
    });

    const expiredPayments: typeof heldPayments = [];
    for (const payment of heldPayments) {
      const heldSince = await this.getHeldSince(payment.id, payment.createdAt);
      if (heldSince < expiryDate) {
        expiredPayments.push(payment);
      }
    }

    if (expiredPayments.length === 0) {
      this.logger.log('No expired held payments found.');
      return;
    }

    for (const payment of expiredPayments) {
      try {
        if (payment.omiseChargeId) {
          const omiseResult = await this.omise.reverseCharge(payment.omiseChargeId);

          try {
            await this.fsm.transition(payment.id, PaymentStatus.expired, {
              reason: 'Hold automatically expired after configured duration',
              metadata: {
                omiseResponseStatus: omiseResult.status,
                expiredAt: new Date().toISOString(),
              },
            });
          } catch (transitionErr) {
            const message =
              transitionErr instanceof Error
                ? transitionErr.message
                : String(transitionErr);
            this.logger.error(
              JSON.stringify({
                alert: 'payment.expire_db_inconsistent',
                paymentId: payment.id,
                omiseChargeId: payment.omiseChargeId,
                message:
                  'Omise hold reversed but DB transition to expired failed — manual reconciliation required',
                error: message,
              }),
            );
            continue;
          }
        } else {
          await this.fsm.transition(payment.id, PaymentStatus.expired, {
            reason: 'Hold automatically expired (No Omise Charge ID)',
          });
        }

        this.eventEmitter.emit('payment.expired', {
          paymentId: payment.id,
          bookingId: payment.bookingId,
          patientId: payment.patientId,
          caregiverId: payment.caregiverId,
        });

        this.logger.log(`Successfully expired held payment: ${payment.id}`);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.logger.error(`Failed to expire payment ${payment.id}: ${message}`);
      }
    }

    this.logger.log('Expired holds cron job completed.');
  }

  /**
   * PYG-4xx — ต่ออายุวงเงิน (hold) ที่ใกล้จะหมดอายุอัตโนมัติ ก่อนถึงวันบริการจริง
   *
   * ทำไมต้องมี: booking จองล่วงหน้าได้หลายวัน (มากกว่า PAYMENT_HOLD_DAYS) แต่ Omise จำกัดอายุ
   * การกันวงเงิน (authorize) ของบัตรไว้ประมาณ 7 วัน ถ้าไม่ต่ออายุ วงเงินจะถูกธนาคารปล่อยเองก่อน
   * ถึงวันบริการ แล้ว handleExpiredHolds ด้านบนจะมา void ทิ้งไปเลย — booking ที่จ่ายเงินแล้ว
   * จะไม่มีวงเงินเหลือให้ capture ตอนจบงาน
   *
   * วิธีทำงาน ต่อ 1 payment ที่เข้าเงื่อนไข:
   *   1) void charge เดิม (best-effort — ถ้าฝั่ง Omise ปล่อยไปเองแล้วก็ถือว่าผ่าน ไม่ block)
   *   2) createChargeForCustomer ด้วย customer/card ที่บันทึกไว้ตอน createPayment (ไม่ใช้ token
   *      เพราะ token เดิมถูกใช้ไปครั้งเดียวตั้งแต่ตอนนั้นแล้ว) — ผ่าน IdempotencyService กัน
   *      สร้าง charge ซ้ำถ้า cron รันซ้ำ/ล้มกลางคัน
   *   3) held → voided → held ใน $transaction เดียว (audit ครบทั้งสองขา + สลับ chargeId)
   *
   * ★ payment เก่าที่สร้างก่อนมี customer/card (omiseCustomerId/omiseCardId เป็น null) จะไม่ถูก
   *   คัดมาเลย — ต่ออายุให้ไม่ได้จริงๆ เพราะไม่มีการ์ดที่ผูกไว้ให้เรียกซ้ำ ปล่อยให้
   *   handleExpiredHolds จัดการตามเดิม (พฤติกรรมเดิมก่อนการ์ดนี้)
   * ★ หยุดต่ออายุถ้าถึงวันบริการแล้ว (bookingDate <= now) — ปล่อยให้ checkout/capture หรือ
   *   safety net อื่น (no-checkout-sweeper) จัดการแทน ไม่ต่ออายุเรื่อยๆ ไม่มีที่สิ้นสุด
   */
  // '0 1 * * *' = ค่าเดิม CronExpression.EVERY_DAY_AT_1AM — ตั้งทับได้ด้วย env แบบ cron ตัวอื่นในโปรเจกต์
  @Cron(process.env['CRON_HOLD_REFRESH'] ?? '0 1 * * *')
  async refreshExpiringHolds(): Promise<void> {
    // ★ ปิดอยู่ = ข้ามทั้งรอบ ไม่แตะ DB ไม่ยิง Omise — log ให้แยกออกจาก "ไม่มีงาน" ได้
    if (!this.isHoldRefreshEnabled()) {
      this.logger.warn(
        `[hold-refresh] ${HOLD_REFRESH_ENABLED_ENV} ไม่ได้เปิด — ข้ามรอบนี้ (ไม่ใช่เพราะไม่มีใบที่ต้องต่ออายุ)`,
      );
      return;
    }

    this.logger.log('Running hold-refresh cron job...');

    const holdDays = Number(this.config.get('PAYMENT_HOLD_DAYS', 7));
    const bufferDays = Number(this.config.get('PAYMENT_HOLD_REFRESH_BUFFER_DAYS', 2));
    const refreshThresholdMs = Math.max(0, holdDays - bufferDays) * 24 * 60 * 60 * 1000;
    const now = Date.now();

    const candidates = await this.prisma.payment.findMany({
      where: {
        paymentStatus: PaymentStatus.held,
        paymentMethod: 'credit_card',
        omiseCustomerId: { not: null },
        omiseCardId: { not: null },
      },
      include: { booking: { select: { bookingDate: true, status: true } } },
      // เก่าสุดก่อน — ใบที่ใกล้หมดอายุที่สุดได้คิวก่อน ไม่ให้ใบใหม่มาเบียดจนใบเก่าอดทุกรอบ
      orderBy: { createdAt: 'asc' },
      take: HOLD_REFRESH_BATCH_CAP,
    });

    if (candidates.length === 0) {
      this.logger.log('No refreshable held payments found.');
      return;
    }

    for (const payment of candidates) {
      try {
        const heldSince = await this.getHeldSince(payment.id, payment.createdAt);
        if (now - heldSince.getTime() < refreshThresholdMs) {
          continue; // ยังไม่ถึงช่วงที่ต้องต่ออายุ
        }
        if (payment.booking.bookingDate.getTime() <= now) {
          this.logger.log(
            `[hold-refresh] payment ${payment.id} ถึงวันบริการแล้ว — ข้าม ปล่อยให้ checkout/capture จัดการ`,
          );
          continue;
        }
        if (['cancelled', 'rejected'].includes(payment.booking.status)) {
          this.logger.warn(
            `[hold-refresh] payment ${payment.id} ยัง held อยู่แต่ booking สถานะ ${payment.booking.status} แล้ว — ข้าม (ตรวจสอบ auto-void flow)`,
          );
          continue;
        }

        // 1) void ของเดิม — best-effort เท่านั้น ถ้าฝั่ง Omise ปล่อยไปเองแล้วก็ไม่ block ขั้นถัดไป
        if (payment.omiseChargeId) {
          try {
            await this.omise.voidCharge(payment.omiseChargeId);
          } catch (voidErr) {
            const m = voidErr instanceof Error ? voidErr.message : String(voidErr);
            this.logger.warn(
              `[hold-refresh] void ของเดิมไม่สำเร็จ (ไปต่อได้ อาจหมดอายุไปแล้วฝั่ง Omise) payment=${payment.id}: ${m}`,
            );
          }
        }

        // 2) authorize ใหม่ด้วย customer/card เดิม (ไม่ใช้ token) — กันซ้ำด้วย idempotency key
        //    ที่อิง chargeId เดิมเป็นส่วนหนึ่ง: ถ้า cron รันซ้ำก่อน chargeId ในข้อ 3 จะอัปเดต
        //    key จะยังเหมือนเดิม → ได้ผลลัพธ์เดิมกลับมา ไม่สร้าง charge ที่สอง
        const amountSatangs = Math.round(Number(payment.amount) * 100);
        const newCharge = await this.idempotency.runOnce({
          key: `reauth:${payment.id}:${payment.omiseChargeId ?? 'none'}`,
          action: 'reauth',
          bookingId: payment.bookingId,
          fn: (idemKey) =>
            this.omise.createChargeForCustomer(
              amountSatangs,
              payment.omiseCustomerId!,
              payment.omiseCardId!,
              idemKey,
            ),
        });

        // 3) held → voided → held ใน transaction เดียว (audit ครบ + สลับ chargeId แล้วเสร็จ)
        await this.prisma.$transaction(async (tx) => {
          await this.fsm.transition(
            payment.id,
            PaymentStatus.voided,
            {
              reason: 'พักวงเงินเดิมเพื่อต่ออายุอัตโนมัติก่อนหมดอายุ (hold refresh)',
              metadata: { oldChargeId: payment.omiseChargeId },
            },
            tx,
          );
          await tx.payment.update({
            where: { id: payment.id },
            data: { omiseChargeId: newCharge.id },
          });
          await this.fsm.transition(
            payment.id,
            PaymentStatus.held,
            {
              reason: 'ต่ออายุวงเงินอัตโนมัติสำเร็จ (hold refresh)',
              metadata: { newChargeId: newCharge.id },
            },
            tx,
          );
        });

        this.eventEmitter.emit('payment.hold_refreshed', {
          paymentId: payment.id,
          bookingId: payment.bookingId,
          oldChargeId: payment.omiseChargeId,
          newChargeId: newCharge.id,
        });

        this.logger.log(
          `[hold-refresh] ต่ออายุวงเงินสำเร็จ payment=${payment.id} newChargeId=${newCharge.id}`,
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.logger.error(`[hold-refresh] ต่ออายุวงเงินไม่สำเร็จ payment=${payment.id}: ${message}`);
      }
    }

    this.logger.log('Hold-refresh cron job completed.');
  }

  /**
   * PYG-309/375 BACKSTOP — abandoned PromptPay janitor.
   *
   * Primary unblock is inline in createPayment (retry hits reconcile immediately). This hourly
   * sweep is for `pending` PromptPay rows nobody retried, so they go terminal for audit +
   * reconciliation. retrieveCharge FIRST (never elapsed-time alone):
   *   paid → captured (webhook lost) · not paid → expired · not found → failed.
   */
  @Cron(CronExpression.EVERY_HOUR)
  async reconcileAbandonedPromptPay(): Promise<void> {
    const hours = Number(this.config.get('PROMPTPAY_ABANDON_HOURS', 1));
    const cutoff = new Date(Date.now() - hours * 60 * 60 * 1000);

    const stale = await this.prisma.payment.findMany({
      where: {
        paymentStatus: PaymentStatus.pending,
        paymentMethod: 'promptpay',
        createdAt: { lt: cutoff },
      },
    });
    if (stale.length === 0) return;

    this.logger.log(`[PromptPayReaper] reconciling ${stale.length} abandoned pending PromptPay`);
    for (const payment of stale) {
      try {
        let target = PaymentStatus.failed;
        let reason = 'PromptPay ไม่มี charge id — ยืนยันไม่ได้';
        if (payment.omiseChargeId) {
          try {
            const charge = await this.omise.retrieveCharge(payment.omiseChargeId);
            if (charge.paid) {
              target = PaymentStatus.captured;
              reason = 'PromptPay จ่ายแล้ว (webhook หาย) — reconcile เป็น captured';
            } else {
              target = PaymentStatus.expired;
              reason = charge.expiresAt
                ? `PromptPay หมดอายุ (expires_at=${charge.expiresAt})`
                : 'PromptPay ยังไม่จ่าย — expired';
            }
          } catch {
            target = PaymentStatus.failed;
            reason = 'PromptPay charge ไม่พบบน Omise';
          }
        }
        await this.fsm.transition(payment.id, target, {
          reason,
          metadata: { omiseChargeId: payment.omiseChargeId, reconciledBy: 'cron' },
        });
        this.logger.log(`[PromptPayReaper] payment ${payment.id} → ${target}`);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        this.logger.error(`[PromptPayReaper] failed ${payment.id}: ${message}`);
      }
    }
  }

  /** PYG-375 — prune idempotency keys older than 30 days (table stays small). */
  @Cron(CronExpression.EVERY_DAY_AT_3AM)
  async pruneIdempotencyKeys(): Promise<void> {
    const removed = await this.idempotency.pruneOlderThan(30);
    if (removed > 0) this.logger.log(`[idempotency] pruned ${removed} keys older than 30 days`);
  }
}
