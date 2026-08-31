-- CreateTable
CREATE TABLE "caregiver_payout_accounts" (
    "id" TEXT NOT NULL,
    "caregiver_id" TEXT NOT NULL,
    "bank_code" TEXT NOT NULL,
    "account_name" TEXT NOT NULL,
    "account_number_enc" TEXT NOT NULL,
    "account_number_last4" TEXT NOT NULL,
    "omise_recipient_id" TEXT,
    "recipient_status" TEXT NOT NULL DEFAULT 'unverified',
    "status" TEXT NOT NULL DEFAULT 'pending',
    "verified_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "caregiver_payout_accounts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "caregiver_payout_accounts_caregiver_id_key"
    ON "caregiver_payout_accounts"("caregiver_id");

-- AddForeignKey
ALTER TABLE "caregiver_payout_accounts"
    ADD CONSTRAINT "caregiver_payout_accounts_caregiver_id_fkey"
    FOREIGN KEY ("caregiver_id") REFERENCES "caregivers"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

-- AlterEnum
ALTER TYPE "NotificationType" ADD VALUE 'payment_transferred';
