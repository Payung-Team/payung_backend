/**
 * PYG-376 — Reconciliation service (READ-ONLY)
 *
 * Pulls three sides together for a date window and flags rows where money and proof
 * disagree:
 *   1. ours     — payments LEFT JOIN payouts (by booking_id)
 *   2. Omise    — retrieveCharge per charge id (batched, timed out, fault-isolated)
 *   3. proof    — check_in/check_out job_events + the reused verdict (MonitoringService)
 *
 * ⚠ This service NEVER writes/patches/transitions anything. It only tells.
 */
import { Injectable, Logger } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '../common/prisma.service';
import { OmiseService, type OmiseCaptureResult } from '../payment/omise/omise.service';
import { MonitoringService } from '../monitoring/monitoring.service';
import { ROLE_ID } from '../common/constants/roles.constant';
import {
  ReconFlag,
  RECON_FLAG_SEVERITY,
  type ReconReport,
  type ReconRow,
} from './reconciliation.types';

/** payment statuses that mean "money was actually collected". */
const CAPTURED_STATUSES = new Set(['captured', 'transferred']);
/** payouts.status value that means money actually left (PYG-330/331: processing → paid). */
const PAYOUT_SUCCESS_STATUS = 'paid';
/** verdict value that permits auto-release (MonitoringService VERDICT.VALID). */
const VERDICT_VALID = 'valid';

/** Omise rate-limit friendliness: N charges per batch, pause between batches. */
const OMISE_BATCH_SIZE = 20;
const OMISE_BATCH_PAUSE_MS = 1000;
const OMISE_CALL_TIMEOUT_MS = 10000;

type PaymentRow = {
  id: string;
  bookingId: string;
  amount: Prisma.Decimal;
  capturedAmount: Prisma.Decimal | null;
  refundedAmount: Prisma.Decimal;
  paymentStatus: string;
  omiseChargeId: string | null;
  createdAt: Date;
};

@Injectable()
export class ReconciliationService {
  private readonly logger = new Logger(ReconciliationService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly omise: OmiseService,
    private readonly monitoring: MonitoringService,
  ) {}

  async buildReport(dateFrom: Date, dateTo: Date): Promise<ReconReport> {
    // ── STEP 1a: ours — payments in window ──────────────────────────────────
    const payments = (await this.prisma.payment.findMany({
      where: { createdAt: { gte: dateFrom, lte: dateTo } },
      select: {
        id: true,
        bookingId: true,
        amount: true,
        capturedAmount: true,
        refundedAmount: true,
        paymentStatus: true,
        omiseChargeId: true,
        createdAt: true,
      },
      orderBy: { createdAt: 'asc' },
    })) as PaymentRow[];

    const bookingIds = [...new Set(payments.map((p) => p.bookingId))];

    // ── STEP 1a: ours — payouts by booking (LEFT JOIN equivalent) ───────────
    const payouts = await this.prisma.payout.findMany({
      where: { bookingId: { in: bookingIds } },
      select: {
        bookingId: true,
        status: true,
        grossAmount: true,
        platformFee: true,
        amount: true,
      },
    });
    const payoutByBooking = new Map(payouts.map((p) => [p.bookingId, p]));

    // ── STEP 1c: proof side — job_events + admin-override history in bulk ────
    const [jobEvents, overrideHistory, bookings] = await Promise.all([
      this.prisma.jobEvent.findMany({
        where: { bookingId: { in: bookingIds } },
        select: { bookingId: true, eventType: true, source: true },
      }),
      this.findAdminOverridePaymentIds(payments.map((p) => p.id)),
      this.prisma.booking.findMany({
        where: { id: { in: bookingIds } },
        select: { id: true, reviewReasons: true, disputeStatus: true },
      }),
    ]);
    const bookingById = new Map(bookings.map((b) => [b.id, b]));
    const checkInByBooking = new Set(
      jobEvents.filter((e) => e.eventType === 'check_in').map((e) => e.bookingId),
    );
    const checkOutByBooking = new Map(
      jobEvents
        .filter((e) => e.eventType === 'check_out')
        .map((e) => [e.bookingId, e.source]),
    );

    // ── STEP 1b: Omise — batched, timed out, fault-isolated ─────────────────
    const chargeResults = await this.fetchOmiseCharges(payments);

    // ── STEP 2: build rows + compute flags ──────────────────────────────────
    const rows: ReconRow[] = payments.map((p) => {
      const booking = bookingById.get(p.bookingId);
      const reviewReasons = booking?.reviewReasons ?? [];
      const disputeStatus = booking?.disputeStatus ?? 'none';

      // reuse the release/verdict rule — do NOT invent our own
      const verdict = this.monitoring.computeVerdict(
        reviewReasons,
        checkInByBooking.has(p.bookingId),
        checkOutByBooking.get(p.bookingId) ?? null,
        disputeStatus,
      );

      const payout = payoutByBooking.get(p.bookingId);
      const omise = chargeResults.get(p.id);
      const unreachable = !!p.omiseChargeId && omise === 'unreachable';
      const charge = omise && omise !== 'unreachable' ? omise : null;

      const flags = this.computeFlags({
        payment: p,
        verdict,
        hasAdminOverride: overrideHistory.has(p.id),
        payoutStatus: payout?.status ?? null,
        charge,
        unreachable,
      });

      return {
        bookingId: p.bookingId,
        paymentId: p.id,
        date: p.createdAt.toISOString(),
        amount: this.toNum(p.amount),
        capturedAmount: p.capturedAmount != null ? this.toNum(p.capturedAmount) : null,
        refundedAmount: this.toNum(p.refundedAmount),
        paymentStatus: p.paymentStatus,
        omiseStatus: charge?.status ?? null,
        payoutStatus: payout?.status ?? null,
        verdict,
        reviewReasons,
        grossAmount: payout?.grossAmount != null ? this.toNum(payout.grossAmount) : null,
        platformFee: payout?.platformFee != null ? this.toNum(payout.platformFee) : null,
        netAmount: payout?.amount != null ? this.toNum(payout.amount) : null,
        omiseUnreachable: unreachable,
        flags,
        primaryFlag: this.primaryFlag(flags),
      };
    });

    // sort worst-first (by primary flag severity), then by date
    rows.sort((a, b) => this.severityRank(a.primaryFlag) - this.severityRank(b.primaryFlag));

    return {
      dateFrom: dateFrom.toISOString(),
      dateTo: dateTo.toISOString(),
      totalRows: rows.length,
      flaggedRows: rows.filter((r) => r.flags.length > 0).length,
      unreachableRows: rows.filter((r) => r.omiseUnreachable).length,
      rows,
    };
  }

  // ── STEP 2: the six flags (severity order) ────────────────────────────────
  private computeFlags(ctx: {
    payment: PaymentRow;
    verdict: string;
    hasAdminOverride: boolean;
    payoutStatus: string | null;
    charge: OmiseCaptureResult | null;
    unreachable: boolean;
  }): ReconFlag[] {
    const { payment: p, verdict, hasAdminOverride, payoutStatus, charge } = ctx;
    const flags: ReconFlag[] = [];
    const isCaptured = CAPTURED_STATUSES.has(p.paymentStatus);

    // 1. CAPTURE_WITHOUT_PROOF — captured but verdict != valid and no admin override
    if (isCaptured && verdict !== VERDICT_VALID && !hasAdminOverride) {
      flags.push(ReconFlag.CAPTURE_WITHOUT_PROOF);
    }

    // 2. PAYOUT_WITHOUT_CAPTURE — payout paid but payment never captured
    if (payoutStatus === PAYOUT_SUCCESS_STATUS && !isCaptured) {
      flags.push(ReconFlag.PAYOUT_WITHOUT_CAPTURE);
    }

    // 6. REFUND_EXCEEDS_CAPTURED — refunded > captured (Omise-independent; satang compare)
    if (p.capturedAmount != null && this.satang(p.refundedAmount) > this.satang(p.capturedAmount)) {
      flags.push(ReconFlag.REFUND_EXCEEDS_CAPTURED);
    }

    // Omise-dependent flags 3/4/5 — skip entirely for unreachable rows
    if (charge) {
      // 3. AMOUNT_MISMATCH — integer satang compare only, never baht floats
      if (this.satang(p.amount) !== BigInt(charge.amount)) {
        flags.push(ReconFlag.AMOUNT_MISMATCH);
      }
      // 4. DB captured but Omise paid=false (DB more optimistic than reality)
      if (isCaptured && !charge.paid) {
        flags.push(ReconFlag.STATUS_MISMATCH_DB_CAPTURED_OMISE_UNPAID);
      }
      // 5. Omise paid=true but DB still pending (lost webhook)
      if (charge.paid && p.paymentStatus === 'pending') {
        flags.push(ReconFlag.STATUS_MISMATCH_OMISE_PAID_DB_PENDING);
      }
    }

    // keep flags in canonical severity order
    return RECON_FLAG_SEVERITY.filter((f) => flags.includes(f));
  }

  /**
   * Admin-override detection for Flag 1 (verified against the code): the capture path
   * writes payment_status_history via the FSM. A normal capture has changed_by =
   * patient/caregiver id (completeBooking) or null (system PromptPay reconcile). An
   * admin force-capture therefore shows changed_by = a user whose role >= ADMIN, with a
   * reason. Returns the set of paymentIds that carry such an override.
   */
  private async findAdminOverridePaymentIds(paymentIds: string[]): Promise<Set<string>> {
    if (paymentIds.length === 0) return new Set();
    const rows = await this.prisma.paymentStatusHistory.findMany({
      where: {
        paymentId: { in: paymentIds },
        toStatus: { in: ['captured', 'transferred'] },
        changedBy: { not: null },
        reason: { not: null },
      },
      select: { paymentId: true, changedBy: true },
    });
    const changerIds = [...new Set(rows.map((r) => r.changedBy!).filter(Boolean))];
    if (changerIds.length === 0) return new Set();
    const admins = await this.prisma.user.findMany({
      where: { id: { in: changerIds }, role: { gte: ROLE_ID.ADMIN } },
      select: { id: true },
    });
    const adminIds = new Set(admins.map((a) => a.id));
    return new Set(
      rows.filter((r) => r.changedBy && adminIds.has(r.changedBy)).map((r) => r.paymentId),
    );
  }

  // ── STEP 1b helper: batched Omise fetch, timeout, fault isolation ─────────
  private async fetchOmiseCharges(
    payments: PaymentRow[],
  ): Promise<Map<string, OmiseCaptureResult | 'unreachable'>> {
    const withCharge = payments.filter((p) => p.omiseChargeId);
    const out = new Map<string, OmiseCaptureResult | 'unreachable'>();

    for (let i = 0; i < withCharge.length; i += OMISE_BATCH_SIZE) {
      const batch = withCharge.slice(i, i + OMISE_BATCH_SIZE);
      await Promise.all(
        batch.map(async (p) => {
          try {
            const charge = await this.withTimeout(
              this.omise.retrieveCharge(p.omiseChargeId!),
              OMISE_CALL_TIMEOUT_MS,
            );
            out.set(p.id, charge);
          } catch (err) {
            // one bad row must NEVER fail the whole report
            const msg = err instanceof Error ? err.message : String(err);
            this.logger.warn(
              `[recon] omise_unreachable payment=${p.id} charge=${p.omiseChargeId}: ${msg}`,
            );
            out.set(p.id, 'unreachable');
          }
        }),
      );
      if (i + OMISE_BATCH_SIZE < withCharge.length) {
        await this.sleep(OMISE_BATCH_PAUSE_MS);
      }
    }
    return out;
  }

  private withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
    return Promise.race([
      promise,
      new Promise<T>((_, reject) =>
        setTimeout(() => reject(new Error(`Omise timeout after ${ms}ms`)), ms),
      ),
    ]);
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, ms));
  }

  // ── amount helpers — satang integers, never baht floats ───────────────────
  /** Decimal baht → BigInt satang (exact; no float). */
  private satang(dec: Prisma.Decimal): bigint {
    return BigInt(dec.times(100).toFixed(0));
  }

  private toNum(dec: Prisma.Decimal): number {
    return dec.toNumber();
  }

  private primaryFlag(flags: ReconFlag[]): ReconFlag | null {
    return flags.length ? flags[0] : null; // already in severity order
  }

  private severityRank(flag: ReconFlag | null | undefined): number {
    if (!flag) return RECON_FLAG_SEVERITY.length; // clean rows sort last
    return RECON_FLAG_SEVERITY.indexOf(flag);
  }
}
