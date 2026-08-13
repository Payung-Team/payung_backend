/**
 * PYG-376 — Reconciliation module (read-only report + daily alert cron).
 *
 * Reuses: OmiseService (PaymentModule), MonitoringService (MonitoringModule),
 * EmailService (EmailModule), PrismaService + ClockService (CommonModule).
 */
import { Module } from '@nestjs/common';
import { CommonModule } from '../common/common.module';
import { PaymentModule } from '../payment/payment.module';
import { MonitoringModule } from '../monitoring/monitoring.module';
import { EmailModule } from '../email/email.module';
import { ReconciliationService } from './reconciliation.service';
import { ReconciliationResolver } from './reconciliation.resolver';
import { ReconciliationCron } from './reconciliation.cron';

@Module({
  imports: [CommonModule, PaymentModule, MonitoringModule, EmailModule],
  providers: [ReconciliationService, ReconciliationResolver, ReconciliationCron],
  exports: [ReconciliationService],
})
export class ReconciliationModule {}
