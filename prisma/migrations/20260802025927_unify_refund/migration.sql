-- PYG-374: Unify refund — add captured_amount + refunded_amount to payments
--
-- Why: refund correctness must be computed as (captured_amount - refunded_amount),
-- never from `amount` alone. Without refunded_amount, several partial refunds can
-- currently sum past 100% of what was collected. RefundService is the only writer
-- of refunded_amount (via one Omise call site).
--
-- ⚠️ PENDING SAM'S DEPLOY — do NOT run migrate dev/db push. Sam runs `migrate deploy`.

-- AlterTable
ALTER TABLE "payments" ADD COLUMN "captured_amount" DECIMAL(10,2);
ALTER TABLE "payments" ADD COLUMN "refunded_amount" DECIMAL(10,2) NOT NULL DEFAULT 0;

-- Backfill: rows that have money collected but not yet refunded → captured_amount = amount.
-- Scope (agreed): only 'captured' and 'transferred' (their refunded_amount is correctly 0).
-- NOTE for Sam: legacy 'partially_refunded'/'refunded' rows are intentionally left with
-- captured_amount = NULL here (their historical refunded_amount is not reliably
-- reconstructable from a bare column). RefundService rejects a refund on any
-- 'partially_refunded' row whose captured_amount IS NULL (→ manual review) so this
-- gap cannot cause a double-refund. If you want those legacy rows made refundable,
-- decide the refunded_amount backfill separately (see PR notes) — not guessed here.
UPDATE "payments"
SET "captured_amount" = "amount"
WHERE "payment_status" IN ('captured', 'transferred');
