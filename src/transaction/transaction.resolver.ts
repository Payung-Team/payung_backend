import { UseGuards } from '@nestjs/common';
import { Args, ID, Query, Resolver } from '@nestjs/graphql';
import { ROLE_ID } from '../common/constants/roles.constant';
import { Roles } from '../common/decorators/roles.decorator';
import { RolesGuard } from '../common/guards/roles.guard';
import { SupabaseAuthGuard } from '../common/guards/supabase-auth.guard';
import { TransactionService } from './transaction.service';
import { AdminTransactionsInput } from './dto/admin-transactions.input';
import {
  TransactionDetail,
  TransactionSummaryConnection,
  TransactionTotals,
} from './dto/transaction.types';

/**
 * PYG-333 — Admin transactions API (read-only)
 *
 * Guard: SupabaseAuthGuard + RolesGuard (admin / super_admin เท่านั้น)
 * ทั้ง 3 op เป็น @Query (read-only) → ไม่มี mutation ที่ trigger payout ตามที่ตั๋วกำหนด
 *
 * ตั๋วเขียนเป็น REST (GET /api/v1/admin/transactions ...) แต่โปรเจกต์นี้ build เป็น GraphQL
 */
@Resolver()
@UseGuards(SupabaseAuthGuard, RolesGuard)
@Roles(ROLE_ID.ADMIN, ROLE_ID.SUPER_ADMIN)
export class TransactionResolver {
  constructor(private readonly transactionService: TransactionService) {}

  // GET /api/v1/admin/transactions
  @Query(() => TransactionSummaryConnection, {
    description:
      'Admin only: รายการ transactions รวม (payment + payout + refund) ' +
      'filter: type, status, dateFrom/dateTo (created_at), q (booking id / omise id / ชื่อ / อีเมล). ' +
      'default: ทุกประเภท เรียง created_desc (ใหม่สุดก่อน) (PYG-333)',
  })
  async adminTransactions(
    @Args('input', { nullable: true, type: () => AdminTransactionsInput })
    input?: AdminTransactionsInput,
  ): Promise<TransactionSummaryConnection> {
    return this.transactionService.adminTransactions(input ?? {});
  }

  // GET /api/v1/admin/transactions/summary
  @Query(() => TransactionTotals, {
    description:
      'Admin only: ผลรวม aggregate ของ transactions ตาม filter เดียวกับ list ' +
      '(count/ยอดรวมของ payment/payout/refund + net) (PYG-333)',
  })
  async adminTransactionSummary(
    @Args('input', { nullable: true, type: () => AdminTransactionsInput })
    input?: AdminTransactionsInput,
  ): Promise<TransactionTotals> {
    return this.transactionService.adminTransactionSummary(input ?? {});
  }

  // GET /api/v1/admin/transactions/:id
  @Query(() => TransactionDetail, {
    description:
      'Admin only: รายละเอียด 1 transaction + status timeline + related links. ' +
      'id เป็น composite "payment:<uuid>" หรือ "payout:<uuid>" (PYG-333)',
  })
  async adminTransaction(
    @Args('id', { type: () => ID }) id: string,
  ): Promise<TransactionDetail> {
    return this.transactionService.adminTransaction(id);
  }
}
