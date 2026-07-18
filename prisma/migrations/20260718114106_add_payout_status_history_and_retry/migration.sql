-- AlterTable
ALTER TABLE "payouts" ADD COLUMN "next_retry_at" TIMESTAMPTZ(3);

-- CreateTable
CREATE TABLE "payout_status_history" (
    "id" TEXT NOT NULL,
    "payout_id" TEXT NOT NULL,
    "from_status" TEXT,
    "to_status" TEXT NOT NULL,
    "changed_by" TEXT,
    "reason" TEXT,
    "metadata" JSONB,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "payout_status_history_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "payout_status_history_payout_id_created_at_idx"
    ON "payout_status_history"("payout_id", "created_at");

-- AddForeignKey
ALTER TABLE "payout_status_history"
    ADD CONSTRAINT "payout_status_history_payout_id_fkey"
    FOREIGN KEY ("payout_id") REFERENCES "payouts"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
