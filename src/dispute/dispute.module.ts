import { Module } from '@nestjs/common';
import { CommonModule } from '../common/common.module';
import { PaymentModule } from '../payment/payment.module';
import { SupabaseAuthGuard } from '../common/guards/supabase-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { DisputeService } from './dispute.service';
import { DisputeResolver } from './dispute.resolver';

@Module({
  imports: [CommonModule, PaymentModule],
  providers: [
    SupabaseAuthGuard,
    RolesGuard,
    DisputeService,
    DisputeResolver,
  ],
})
export class DisputeModule {}
