/**
 * PayoutModule — PYG-330 (ก้อน B)
 *
 * - PayoutCreationListener: ฟัง booking.completed → เรียก PayoutService
 * - PayoutWorkerService: @Cron ทุก 10 นาที → หา payouts ที่ถึงกำหนดโอนเงิน
 *
 * ต้อง import PaymentModule เพื่อใช้ OmiseService และ NotificationModule
 * เพื่อใช้ NotificationService (สอง module นี้ export service เดียวออกมา อยู่แล้ว)
 *
 * ไม่ export อะไร — ไม่มี module อื่นเรียก PayoutService/PayoutWorkerService โดยตรง
 * (jakkapun's PYG-337 จะเปิด GraphQL/REST endpoint ของตัวเอง)
 */
import { Module } from '@nestjs/common';
import { PrismaService } from '../common/prisma.service';
import { PaymentModule } from '../payment/payment.module';
import { NotificationModule } from '../notification/notification.module';
import { PayoutService } from './payout.service';
import { PayoutWorkerService } from './payout-worker.service';
import { PayoutCreationListener } from './listeners/payout-creation.listener';
import { PayoutStateMachine } from './payout-state-machine';
import { PayoutRetryPolicy } from './payout-retry-policy';
import { PayoutKillswitch } from './payout-killswitch';
import { PayoutReaperService } from './payout-reaper.service';

@Module({
  imports: [PaymentModule, NotificationModule],
  providers: [
    PrismaService,
    // PYG-331: state machine + retry + kill-switch + reaper
    PayoutStateMachine,
    PayoutRetryPolicy,
    PayoutKillswitch,
    PayoutReaperService,
    // Existing (PYG-330)
    PayoutService,
    PayoutWorkerService,
    PayoutCreationListener,
  ],
})
export class PayoutModule {}
