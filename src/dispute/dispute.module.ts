import { Module } from '@nestjs/common';
import { CommonModule } from '../common/common.module';
import { PaymentStateMachine } from '../payment/payment-state-machine';
import { PaymentService } from '../payment/payment.service';
import { SupabaseAuthGuard } from '../common/guards/supabase-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { DisputeService } from './dispute.service';
import { DisputeResolver } from './dispute.resolver';

@Module({
  imports: [CommonModule],
  providers: [
    PaymentStateMachine,
    PaymentService,
    SupabaseAuthGuard,
    RolesGuard,
    DisputeService,
    DisputeResolver,
  ],
})
export class DisputeModule {}
