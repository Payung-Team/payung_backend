import { Module } from '@nestjs/common';
import { PaymentStateMachine } from './payment-state-machine';
import { PaymentService } from './payment.service';
import { RefundService } from './refund.service';
import { IdempotencyService } from './idempotency.service';
import { PaymentResolver } from './payment.resolver';
import { OmiseService } from './omise/omise.service';
import { CompleteBookingService } from './complete-booking.service';
import { CompleteBookingResolver } from './complete-booking.resolver';
import { PaymentCronService } from './payment-cron.service';
import { PayoutAccountService } from './payout-account.service';
import { BookingSettlementService } from './settlement/booking-settlement.service';
import { OmiseController } from './webhook/omise.controller';
import { SupabaseAuthGuard } from '../common/guards/supabase-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';

@Module({
  controllers: [OmiseController],
  providers: [
    PaymentStateMachine,
    PaymentService,
    RefundService,
    IdempotencyService,
    PaymentResolver,
    // PYG-281: capture charge + completeBooking (patient/caregiver)
    OmiseService,
    CompleteBookingService,
    CompleteBookingResolver,
    PaymentCronService,
    // PYG-266: Omise Recipient creation + webhook handling for payout accounts
    PayoutAccountService,
    // PYG-461/462 เฟส 2: core ปิด booking + settle เงิน — ตั้งใจไม่ export (ยังไม่มี flow เรียก)
    // เฟส 3a/3b จะ export + ต่อ flow ผู้ป่วยยกเลิก / cron no-show
    BookingSettlementService,
    SupabaseAuthGuard,
    RolesGuard,
  ],
  exports: [
    PaymentStateMachine,
    OmiseService,
    PaymentService,
    RefundService,
    PayoutAccountService,
  ],
})
export class PaymentModule {}
