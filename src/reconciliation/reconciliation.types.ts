/**
 * PYG-376 — Reconciliation report types
 *
 * Read-only: this module compares payments (+payouts) vs Omise vs the proof/verdict
 * side and flags disagreements. It NEVER mutates a row.
 */
import { Field, Float, ID, Int, InputType, ObjectType, registerEnumType } from '@nestjs/graphql';
import { IsDateString } from 'class-validator';

/**
 * Mismatch flags in SEVERITY ORDER (index 0 = most severe).
 * A row may carry several; the primary (for sorting) is the highest-severity present.
 */
export enum ReconFlag {
  /** captured/transferred but verdict != valid and no admin override → gate leaking */
  CAPTURE_WITHOUT_PROOF = 'CAPTURE_WITHOUT_PROOF',
  /** payout paid but payment never captured → paid out money we never collected */
  PAYOUT_WITHOUT_CAPTURE = 'PAYOUT_WITHOUT_CAPTURE',
  /** satang(payments.amount) != omiseCharge.amount */
  AMOUNT_MISMATCH = 'AMOUNT_MISMATCH',
  /** DB captured but Omise paid=false (DB more optimistic than reality) */
  STATUS_MISMATCH_DB_CAPTURED_OMISE_UNPAID = 'STATUS_MISMATCH_DB_CAPTURED_OMISE_UNPAID',
  /** Omise paid=true but DB still pending (lost webhook) */
  STATUS_MISMATCH_OMISE_PAID_DB_PENDING = 'STATUS_MISMATCH_OMISE_PAID_DB_PENDING',
  /** refunded_amount > captured_amount */
  REFUND_EXCEEDS_CAPTURED = 'REFUND_EXCEEDS_CAPTURED',
}

registerEnumType(ReconFlag, { name: 'ReconFlag' });

/** severity order — earlier = worse. Used to derive the primary flag + sort rows. */
export const RECON_FLAG_SEVERITY: ReconFlag[] = [
  ReconFlag.CAPTURE_WITHOUT_PROOF,
  ReconFlag.PAYOUT_WITHOUT_CAPTURE,
  ReconFlag.AMOUNT_MISMATCH,
  ReconFlag.STATUS_MISMATCH_DB_CAPTURED_OMISE_UNPAID,
  ReconFlag.STATUS_MISMATCH_OMISE_PAID_DB_PENDING,
  ReconFlag.REFUND_EXCEEDS_CAPTURED,
];

/** the two flags that trigger an immediate admin email (STEP 4). */
export const ALERT_FLAGS: ReconFlag[] = [
  ReconFlag.CAPTURE_WITHOUT_PROOF,
  ReconFlag.PAYOUT_WITHOUT_CAPTURE,
];

@ObjectType()
export class ReconRow {
  @Field(() => ID) bookingId!: string;
  @Field() paymentId!: string;
  /** payment.created_at ISO */
  @Field() date!: string;

  // ── amounts (baht, for display — Float like transaction.types money fields) ──
  @Field(() => Float) amount!: number;
  @Field(() => Float, { nullable: true }) capturedAmount?: number | null;
  @Field(() => Float) refundedAmount!: number;

  @Field() paymentStatus!: string;
  /** Omise charge.status, or null when no charge id / unreachable */
  @Field(() => String, { nullable: true }) omiseStatus?: string | null;
  @Field(() => String, { nullable: true }) payoutStatus?: string | null;

  @Field() verdict!: string;
  @Field(() => [String]) reviewReasons!: string[];

  // ── payout money columns for the CSV (baht) ──
  @Field(() => Float, { nullable: true }) grossAmount?: number | null;
  @Field(() => Float, { nullable: true }) platformFee?: number | null;
  @Field(() => Float, { nullable: true }) netAmount?: number | null;

  /** Omise charge couldn't be fetched — flags 3/4/5 are NOT evaluated for this row. */
  @Field() omiseUnreachable!: boolean;

  @Field(() => [ReconFlag]) flags!: ReconFlag[];
  /** highest-severity flag present, or null when the row is clean. */
  @Field(() => ReconFlag, { nullable: true }) primaryFlag?: ReconFlag | null;
}

@ObjectType()
export class ReconReport {
  @Field() dateFrom!: string;
  @Field() dateTo!: string;
  @Field(() => Int) totalRows!: number;
  @Field(() => Int) flaggedRows!: number;
  @Field(() => Int) unreachableRows!: number;
  @Field(() => [ReconRow]) rows!: ReconRow[];
}

@InputType()
export class ReconciliationReportInput {
  @Field() @IsDateString() dateFrom!: string;
  @Field() @IsDateString() dateTo!: string;
}
