-- PYG-XX: Add caregiverNumber, gender, dateOfBirth to caregivers
--
-- Changes:
-- 1. caregiver_number — system-generated read-only ID (CG-0001)
-- 2. gender           — "male" | "female" | "other"
-- 3. date_of_birth    — locked after KYC submit

ALTER TABLE "caregivers" ADD COLUMN "caregiver_number" TEXT;
ALTER TABLE "caregivers" ADD COLUMN "gender" TEXT;
ALTER TABLE "caregivers" ADD COLUMN "date_of_birth" TIMESTAMP(3);
ALTER TABLE "caregivers" ADD COLUMN "address" TEXT;

CREATE UNIQUE INDEX "caregivers_caregiver_number_key" ON "caregivers"("caregiver_number");
