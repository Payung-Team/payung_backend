-- PYG-375: idempotency_keys — deterministic once-only execution for money commands
--
-- One row per (deterministic) key. The key is INSERTed BEFORE the Omise call:
-- a PK collision means the command is already in-flight / already done, so the
-- caller returns the stored `result` instead of calling Omise a second time.
-- The same key is ALSO sent as the Omise-Idempotency-Key header (two layers).
--
-- Keys are deterministic (never random):
--   capture  : capture:{bookingId}
--   refund   : refund:{paymentId}:{refunded_amount_before}   (already used by RefundService)
--   payout   : payout:{payoutId}
--   transfer : transfer:{payoutId}:{attempt}
--
-- A cron deletes rows older than 30 days.
--
-- ⚠️ PENDING SAM'S DEPLOY — do NOT run migrate dev / db push. Sam runs `migrate deploy`.

-- CreateTable
CREATE TABLE "idempotency_keys" (
    "key" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "booking_id" UUID,
    "result" JSONB,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "idempotency_keys_pkey" PRIMARY KEY ("key")
);

-- CreateIndex (cron cleanup by age)
CREATE INDEX "idempotency_keys_created_at_idx" ON "idempotency_keys" ("created_at");
