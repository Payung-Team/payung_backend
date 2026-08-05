import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { ConfigService } from '@nestjs/config';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { PrismaService } from '../common/prisma.service';
import { OmiseService } from './omise/omise.service';
import { PaymentStateMachine } from './payment-state-machine';
import { PaymentStatus } from './entities/payment-status.enum';
import { IdempotencyService } from './idempotency.service';

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

  @Cron(CronExpression.EVERY_DAY_AT_2AM)
  async handleExpiredHolds(): Promise<void> {
    this.logger.log('Running expired holds cron job...');

    const holdDays = Number(this.config.get('PAYMENT_HOLD_DAYS', 7));
    const expiryDate = new Date();
    expiryDate.setDate(expiryDate.getDate() - holdDays);

    const expiredPayments = await this.prisma.payment.findMany({
      where: {
        paymentStatus: PaymentStatus.held,
        createdAt: {
          lt: expiryDate,
        },
      },
    });

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
