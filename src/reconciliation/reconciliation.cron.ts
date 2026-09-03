/**
 * PYG-376 — daily reconciliation cron.
 *
 * ⚠ SCHEDULE NOTE (flagged for review): the card assumed 03:00 was free, but PYG-375 since
 * added `pruneIdempotencyKeys` at 03:00 daily and `reconcileAbandonedPromptPay` hourly (also
 * hits 03:00); payout worker/reaper run every 10 min (unavoidable at any wall-clock). This
 * report is READ-ONLY, so overlap poses no data-corruption risk — only concurrent load. The
 * schedule is env-overridable via CRON_RECONCILE; recommend setting e.g. '0 4 * * *' in prod
 * to avoid stacking on the 03:00 idempotency prune. Default kept at the card's '0 3 * * *'.
 *
 * ⚠ PROD SEQUENCING: must run AFTER PYG-375 stuck-payment repair `--apply`, else still-stuck
 * rows produce false STATUS_MISMATCH_OMISE_PAID_DB_PENDING (Flag 5). Do not enable the prod
 * cron until that repair is done.
 */
import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { PrismaService } from '../common/prisma.service';
import { ClockService } from '../common/clock.service';
import { EmailService } from '../email/email.service';
import { ROLE_ID } from '../common/constants/roles.constant';
import { ReconciliationService } from './reconciliation.service';
import { ReconFlag, ALERT_FLAGS, isInfoTierOnly, type ReconRow } from './reconciliation.types';

/** how far back each daily run looks. */
const RECON_WINDOW_HOURS = 24;

@Injectable()
export class ReconciliationCron {
  private readonly logger = new Logger(ReconciliationCron.name);

  constructor(
    private readonly service: ReconciliationService,
    private readonly prisma: PrismaService,
    private readonly email: EmailService,
    private readonly clock: ClockService,
  ) {}

  @Cron(process.env['CRON_RECONCILE'] ?? '0 3 * * *')
  async run(): Promise<void> {
    const now = this.clock.now();
    const from = new Date(now.getTime() - RECON_WINDOW_HOURS * 60 * 60 * 1000);

    const report = await this.service.buildReport(from, now);

    // per-flag counts
    const counts = new Map<ReconFlag, number>();
    for (const row of report.rows) {
      for (const f of row.flags) counts.set(f, (counts.get(f) ?? 0) + 1);
    }

    const alertRows = report.rows.filter((r) =>
      r.flags.some((f) => ALERT_FLAGS.includes(f)),
    );

    if (alertRows.length > 0) {
      // Flag 1 or Flag 2 fired → email admins immediately + log at ERROR
      this.logger.error({
        event: 'recon.critical',
        window: { from: from.toISOString(), to: now.toISOString() },
        alertRows: alertRows.length,
        counts: Object.fromEntries(counts),
      });
      await this.emailAdmins(from, now, alertRows, counts);
      return;
    }

    // rows carrying a non-alert, non-INFO flag (3/4/5/6) → warn (no email)
    const warnRows = report.rows.filter(
      (r) => r.flags.length > 0 && !isInfoTierOnly(r.flags),
    );
    if (warnRows.length > 0 || report.unreachableRows > 0) {
      this.logger.warn({
        event: 'recon.flags',
        warnRows: warnRows.length,
        unreachableRows: report.unreachableRows,
        counts: Object.fromEntries(counts),
      });
      return;
    }

    // INFO-tier only (e.g. HELD_AWAITING_PROOF) → info log, NEVER emails
    const infoRows = report.rows.filter((r) => r.flags.length > 0);
    if (infoRows.length > 0) {
      this.logger.log({
        event: 'recon.info',
        infoRows: infoRows.length,
        counts: Object.fromEntries(counts),
      });
      return;
    }

    // nothing found → info so we know the cron is alive
    this.logger.log({ event: 'recon.clean', totalRows: report.totalRows });
  }

  private async emailAdmins(
    from: Date,
    to: Date,
    alertRows: ReconRow[],
    counts: Map<ReconFlag, number>,
  ): Promise<void> {
    const admins = await this.prisma.user.findMany({
      where: { role: { gte: ROLE_ID.ADMIN }, isActive: true, is_deleted: false },
      select: { email: true },
    });
    const recipients = admins.map((a) => a.email).filter(Boolean);

    const lines = [
      `Reconciliation ALERT — ${alertRows.length} critical row(s)`,
      `Window: ${from.toISOString()} → ${to.toISOString()}`,
      '',
      'Counts by flag:',
      ...[...counts.entries()].map(([f, n]) => `  ${f}: ${n}`),
      '',
      'Critical rows (Flag 1 / Flag 2):',
      ...alertRows
        .slice(0, 50)
        .map(
          (r) =>
            `  booking=${r.bookingId} payment=${r.paymentId} status=${r.paymentStatus} ` +
            `payout=${r.payoutStatus ?? '-'} verdict=${r.verdict} flag=${r.primaryFlag}`,
        ),
      alertRows.length > 50 ? `  …and ${alertRows.length - 50} more` : '',
    ].filter(Boolean);

    await this.email.sendAdminAlert(
      recipients,
      `[Payung] Reconciliation ALERT — ${alertRows.length} critical row(s)`,
      lines.join('\n'),
    );
  }
}
