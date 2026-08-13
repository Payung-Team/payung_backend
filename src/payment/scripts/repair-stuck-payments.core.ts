/**
 * PYG-375 STEP 2 — repair-stuck-payments CORE (pure, unit-testable; no Nest, no I/O)
 *
 * ⚠ THE INVARIANT: read-only against Omise, write-only against our DB, never moves money.
 * This file only *decides* what a stuck `pending` row should become given Omise's answer.
 * The actual DB write (FSM transition) lives in the CLI and only runs under --apply.
 *
 * Decision table (§4) — we reconcile OUR db to what Omise ALREADY did; we never make Omise act:
 *   omise paid=true                        → captured  (+captured_amount from omise) [webhook-lost]
 *   omise paid=false & authorized=true     → held      (authorized hold, money reserved not taken)
 *   omise paid=false & authorized=false    → expired   (only because we ASKED omise; never on time alone)
 *   omise 404 not found                    → failed
 *   omise_charge_id is NULL                → failed    (charge never created)
 *   omise unreachable (timeout/net/5xx)    → SKIP      (leave pending, re-run later — never guess a write)
 */
import { Prisma } from '@prisma/client';
import { PaymentStatus } from '../entities/payment-status.enum';

export type StuckPayment = {
  id: string;
  bookingId: string;
  paymentMethod: string;
  amount: Prisma.Decimal;
  omiseChargeId: string | null;
  paymentStatus: string;
};

/** outcome of asking Omise about one charge (a GET only — never money-moving). */
export type ChargeOutcome =
  | { kind: 'ok'; paid: boolean; authorized: boolean; amountSatang: number }
  | { kind: 'not_found' }
  | { kind: 'unreachable' }
  | { kind: 'no_charge_id' };

export enum RepairBucket {
  CAPTURED = '→captured (webhook-lost)',
  HELD = '→held',
  EXPIRED = '→expired',
  FAILED = '→failed',
  SKIP_UNREACHABLE = 'skip:omise_unreachable',
  SKIP_ALREADY_MOVED = 'skip:already_moved',
}

export type PlanRow = {
  paymentId: string;
  bookingId: string;
  method: string;
  amountBaht: number;
  currentStatus: string;
  omiseChargeId: string | null;
  omisePaid: boolean | null;
  omiseCaptured: boolean | null;
  omiseAmountSatang: number | null;
  /** null = no DB write proposed (skip bucket). */
  proposedStatus: PaymentStatus | null;
  bucket: RepairBucket;
  reason: string;
  /** only set for →captured: captured_amount to persist (baht). */
  capturedAmountBaht: number | null;
};

/** Decide the plan for one stuck row from Omise's answer. Pure. */
export function planRow(p: StuckPayment, outcome: ChargeOutcome): PlanRow {
  const base = {
    paymentId: p.id,
    bookingId: p.bookingId,
    method: p.paymentMethod,
    amountBaht: p.amount.toNumber(),
    currentStatus: p.paymentStatus,
    omiseChargeId: p.omiseChargeId,
    omisePaid: null as boolean | null,
    omiseCaptured: null as boolean | null,
    omiseAmountSatang: null as number | null,
    capturedAmountBaht: null as number | null,
  };

  switch (outcome.kind) {
    case 'no_charge_id':
      return {
        ...base,
        proposedStatus: PaymentStatus.failed,
        bucket: RepairBucket.FAILED,
        reason: 'PYG-375 repair: omise_charge_id is NULL (charge never created) → failed',
      };

    case 'not_found':
      return {
        ...base,
        proposedStatus: PaymentStatus.failed,
        bucket: RepairBucket.FAILED,
        reason: 'PYG-375 repair: omise 404 not_found → failed',
      };

    case 'unreachable':
      // never write on a non-answer — leave pending, re-run later
      return {
        ...base,
        proposedStatus: null,
        bucket: RepairBucket.SKIP_UNREACHABLE,
        reason: 'PYG-375 repair: omise unreachable (timeout/network/5xx) → skip, left pending',
      };

    case 'ok': {
      const withOmise = {
        ...base,
        omisePaid: outcome.paid,
        omiseCaptured: outcome.paid, // retrieveCharge aliases captured=paid (see PR note)
        omiseAmountSatang: outcome.amountSatang,
      };
      if (outcome.paid) {
        return {
          ...withOmise,
          proposedStatus: PaymentStatus.captured,
          bucket: RepairBucket.CAPTURED,
          capturedAmountBaht: satangToBaht(outcome.amountSatang),
          reason: 'PYG-375 repair: omise paid=true captured=true (webhook lost) → captured',
        };
      }
      if (outcome.authorized) {
        return {
          ...withOmise,
          proposedStatus: PaymentStatus.held,
          bucket: RepairBucket.HELD,
          reason: 'PYG-375 repair: omise paid=false authorized=true (hold) → held',
        };
      }
      return {
        ...withOmise,
        proposedStatus: PaymentStatus.expired,
        bucket: RepairBucket.EXPIRED,
        reason: 'PYG-375 repair: omise paid=false authorized=false (asked omise) → expired',
      };
    }
  }
}

/** satang int → baht number (exact via Decimal, no float drift). */
export function satangToBaht(satang: number): number {
  return new Prisma.Decimal(satang).div(100).toNumber();
}

/** per-bucket counts for the stdout summary. */
export function summarize(rows: PlanRow[]): Record<RepairBucket, number> {
  const counts = Object.values(RepairBucket).reduce(
    (acc, b) => ({ ...acc, [b]: 0 }),
    {} as Record<RepairBucket, number>,
  );
  for (const r of rows) counts[r.bucket] += 1;
  return counts;
}

const CSV_HEADERS = [
  'paymentId',
  'bookingId',
  'method',
  'amountBaht',
  'currentStatus',
  'omiseChargeId',
  'omisePaid',
  'omiseCaptured',
  'omiseAmountSatang',
  'proposedStatus',
  'bucket',
  'reason',
] as const;

/** Excel-friendly UTF-8 BOM — without it Thai reasons render as mojibake. */
export const UTF8_BOM = '﻿';

function cell(v: unknown): string {
  const s = v === null || v === undefined ? '' : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** plan → UTF-8-with-BOM CSV (written in BOTH dry-run and apply). */
export function toCsv(rows: PlanRow[]): string {
  const lines = [CSV_HEADERS.join(',')];
  for (const r of rows) {
    lines.push(
      [
        r.paymentId,
        r.bookingId,
        r.method,
        r.amountBaht,
        r.currentStatus,
        r.omiseChargeId ?? '',
        r.omisePaid ?? '',
        r.omiseCaptured ?? '',
        r.omiseAmountSatang ?? '',
        r.proposedStatus ?? '',
        r.bucket,
        r.reason,
      ]
        .map(cell)
        .join(','),
    );
  }
  return UTF8_BOM + lines.join('\r\n') + '\r\n';
}
