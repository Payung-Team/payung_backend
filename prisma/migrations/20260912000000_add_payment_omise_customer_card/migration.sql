-- payments: เก็บ Omise customer / card id ไว้จ่ายซ้ำ (saved card) — งานของ Christina
--
-- ⚠ เขียนมือ ห้ามรัน prisma migrate dev / db push — Wasan รัน `prisma migrate deploy` เท่านั้น
--
-- ADD COLUMN nullable ล้วน ไม่มี default ไม่มี backfill ไม่แตะแถวเดิม → ไม่ล็อกตารางนาน
-- ยังไม่ใส่ index: รอให้รู้ก่อนว่า query pattern คืออะไร (ค้นด้วย customer id ต่อ patient หรือไม่)
--
-- ROLLBACK:
--   ALTER TABLE "payments" DROP COLUMN IF EXISTS "omise_customer_id", DROP COLUMN IF EXISTS "omise_card_id";
--   DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20260912000000_add_payment_omise_customer_card';

ALTER TABLE "payments"
  ADD COLUMN IF NOT EXISTS "omise_customer_id" TEXT,
  ADD COLUMN IF NOT EXISTS "omise_card_id" TEXT;
