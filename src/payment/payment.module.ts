import { Module } from '@nestjs/common';
import { PaymentStateMachine } from './payment-state-machine';
import { OmiseService } from './omise.service';
import { PaymentService } from './payment.service';
import { PaymentResolver } from './payment.resolver';
import { OmiseController } from './webhook/omise.controller';
import { SupabaseAuthGuard } from '../common/guards/supabase-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { NotificationModule } from '../notification/notification.module';

@Module({
  imports: [NotificationModule],
  controllers: [OmiseController],
  providers: [
    PaymentStateMachine,
    OmiseService,
    PaymentService,
    PaymentResolver,
    SupabaseAuthGuard,
    RolesGuard,
  ],
  exports: [PaymentStateMachine, OmiseService],
})
export class PaymentModule {}
