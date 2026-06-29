import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { ConfigService } from '@nestjs/config';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { PrismaService } from '../common/prisma.service';
import { OmiseService } from './omise/omise.service';
import { PaymentStateMachine } from './payment-state-machine';
import { PaymentStatus } from './entities/payment-status.enum';

@Injectable()
export class PaymentCronService {
  private readonly logger = new Logger(PaymentCronService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly omise: OmiseService,
    private readonly fsm: PaymentStateMachine,
    private readonly eventEmitter: EventEmitter2,
    private readonly config: ConfigService,
  ) {}

  // @Cron(CronExpression.EVERY_DAY_AT_2AM) — disabled for demo
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
}
