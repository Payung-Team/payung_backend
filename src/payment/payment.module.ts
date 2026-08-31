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
    SupabaseAuthGuard,
    RolesGuard,
  ],
  exports: [PaymentStateMachine, OmiseService, PaymentService, RefundService],
})
export class PaymentModule {}
