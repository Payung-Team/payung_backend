-- CreateTable
CREATE TABLE "payouts" (
    "id" TEXT NOT NULL,
    "booking_id" UUID NOT NULL,
    "caregiver_id" TEXT NOT NULL,
    "recipient_id" TEXT,
    "amount" DECIMAL(10,2) NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'scheduled',
    "scheduled_at" TIMESTAMPTZ(3) NOT NULL,
    "processed_at" TIMESTAMPTZ(3),
    "omise_transfer_id" TEXT,
    "retry_count" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "payouts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex (idempotency: 1 booking = 1 payout — enforced at DB level, not just code)
CREATE UNIQUE INDEX "payouts_booking_id_key" ON "payouts"("booking_id");

-- CreateIndex (worker query: WHERE status='scheduled' AND scheduled_at <= now())
CREATE INDEX "payouts_status_scheduled_at_idx" ON "payouts"("status", "scheduled_at");

-- AddForeignKey (booking_id → bookings.id — UUID↔UUID, RESTRICT: no cascade delete of money records)
ALTER TABLE "payouts"
    ADD CONSTRAINT "payouts_booking_id_fkey"
    FOREIGN KEY ("booking_id") REFERENCES "bookings"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey (caregiver_id → caregivers.id — TEXT↔TEXT, RESTRICT)
ALTER TABLE "payouts"
    ADD CONSTRAINT "payouts_caregiver_id_fkey"
    FOREIGN KEY ("caregiver_id") REFERENCES "caregivers"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;
