/**
 * PYG-376 — Reconciliation resolver (admin-only, read-only)
 *
 * - reconciliationReport(input)     → structured ReconReport
 * - reconciliationReportCsv(input)  → UTF-8-with-BOM CSV string (Thai-safe in Excel)
 */
import { UseGuards } from '@nestjs/common';
import { Args, Query, Resolver } from '@nestjs/graphql';
import { ROLE_ID } from '../common/constants/roles.constant';
import { Roles } from '../common/decorators/roles.decorator';
import { RolesGuard } from '../common/guards/roles.guard';
import { SupabaseAuthGuard } from '../common/guards/supabase-auth.guard';
import { ReconciliationService } from './reconciliation.service';
import { reconRowsToCsv } from './reconciliation.csv';
import { ReconReport, ReconciliationReportInput } from './reconciliation.types';

@Resolver()
@UseGuards(SupabaseAuthGuard, RolesGuard)
@Roles(ROLE_ID.ADMIN, ROLE_ID.SUPER_ADMIN)
export class ReconciliationResolver {
  constructor(private readonly service: ReconciliationService) {}

  @Query(() => ReconReport, {
    description: 'Admin only: reconciliation report (payments vs Omise vs payouts) for a date window.',
  })
  async reconciliationReport(
    @Args('input') input: ReconciliationReportInput,
  ): Promise<ReconReport> {
    return this.service.buildReport(new Date(input.dateFrom), new Date(input.dateTo));
  }

  @Query(() => String, {
    description: 'Admin only: the same reconciliation report as a UTF-8-with-BOM CSV string.',
  })
  async reconciliationReportCsv(
    @Args('input') input: ReconciliationReportInput,
  ): Promise<string> {
    const report = await this.service.buildReport(
      new Date(input.dateFrom),
      new Date(input.dateTo),
    );
    return reconRowsToCsv(report.rows);
  }
}
