import { Module } from '@nestjs/common';
import { CommonModule } from '../common/common.module';
import { SupabaseAuthGuard } from '../common/guards/supabase-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { TransactionService } from './transaction.service';
import { TransactionResolver } from './transaction.resolver';

/**
 * PYG-333 — Admin transactions module (read-only)
 * รวมข้อมูล payments + payouts เป็น view เดียวให้ admin ดู
 */
@Module({
  imports: [CommonModule],
  providers: [
    SupabaseAuthGuard,
    RolesGuard,
    TransactionService,
    TransactionResolver,
  ],
})
export class TransactionModule {}
