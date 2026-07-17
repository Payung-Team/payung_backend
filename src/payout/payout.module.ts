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

@Module({
  imports: [PaymentModule, NotificationModule],
  providers: [
    PrismaService,
    PayoutService,
    PayoutWorkerService,
    PayoutCreationListener,
  ],
})
export class PayoutModule {}
