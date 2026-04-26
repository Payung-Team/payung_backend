-- AlterTable: เพิ่ม resubmit_count column ให้ caregivers table
-- ใช้เก็บ audit log จำนวนครั้งที่ caregiver resubmit KYC หลังถูก reject
-- default 0 = ยังไม่เคย resubmit
ALTER TABLE "caregivers" ADD COLUMN "resubmit_count" INTEGER NOT NULL DEFAULT 0;
