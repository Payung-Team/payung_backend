-- PYG-333: indexes รองรับ admin transactions list (read-only)
-- default sort = created_at DESC และ filter ช่วงวันที่ (dateFrom/dateTo) ทำงานบน created_at
--
-- ⚠️ ยังไม่ deploy — เขียนด้วยมือ รอ Sam review ตาม workflow ทีม (PYG-341)
--     ห้าม prisma migrate dev / prisma db push ; deploy ด้วย prisma migrate deploy หลัง review
-- ใช้ IF NOT EXISTS ให้ idempotent (รันซ้ำ/DB มี index อยู่แล้ว ก็ไม่พัง)

CREATE INDEX IF NOT EXISTS "idx_payments_created_at" ON "payments" ("created_at");
CREATE INDEX IF NOT EXISTS "idx_payouts_created_at" ON "payouts" ("created_at");
