-- ฟีดแบ็กอาจารย์ Sprint 9 ข้อ 2 — ตารางราคากลางต่อ service_type (แทนราคาที่ผู้ดูแลตั้งเอง)
--
-- ⚠ เขียนมือ ห้ามรัน prisma migrate dev / db push — Wasan รัน `prisma migrate deploy` เท่านั้น
--
-- สิ่งที่ไฟล์นี้ทำ: สร้างตาราง service_price_catalog + seed 5 แถว (300.00 บาท/ชม. เท่ากันไปก่อน ตาม PYG-490)
--   ไม่แตะตารางเดิม (caregivers.hourly_rate ยังอยู่) · ไม่มี backfill
--   booking เดิมใช้ estimated_cost ที่บันทึกไว้แล้ว → ไม่กระทบ · โค้ดยังไม่อ่านตารางนี้ (งานถัดไป)
--
-- Dry-run (prod, 2026-09-28, PG 17.6):
--   SELECT to_regclass('public.service_price_catalog')                → NULL
--   SELECT job_type, count(*) FROM caregiver_job_types GROUP BY 1       → general_care, bedridden_care,
--                                                                          physiotherapy, medication, companion (5 ค่าพอดี)
--   SELECT service_type, count(*) FROM bookings GROUP BY 1              → ไม่มีค่านอก 5 ค่านี้
--
-- ROLLBACK (มือ):
--   DROP TABLE IF EXISTS "service_price_catalog";
--   DELETE FROM "_prisma_migrations" WHERE migration_name = '20260928000000_add_service_price_catalog';

-- CreateTable
CREATE TABLE "service_price_catalog" (
    "id" TEXT NOT NULL,
    "service_type" TEXT NOT NULL,
    "price_per_hour" DECIMAL(10,2) NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "service_price_catalog_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "service_price_catalog_price_positive" CHECK ("price_per_hour" > 0)
);

-- CreateIndex
CREATE UNIQUE INDEX "service_price_catalog_service_type_key" ON "service_price_catalog"("service_type");

-- Seed (ราคาชั่วคราว รอราคาจริงจากทีม/อาจารย์ — เปลี่ยนด้วย UPDATE ได้ไม่ต้อง deploy)
INSERT INTO "service_price_catalog" ("id", "service_type", "price_per_hour", "is_active", "updated_at")
VALUES
    (gen_random_uuid()::text, 'general_care',   300.00, true, CURRENT_TIMESTAMP),
    (gen_random_uuid()::text, 'bedridden_care', 300.00, true, CURRENT_TIMESTAMP),
    (gen_random_uuid()::text, 'physiotherapy',  300.00, true, CURRENT_TIMESTAMP),
    (gen_random_uuid()::text, 'medication',     300.00, true, CURRENT_TIMESTAMP),
    (gen_random_uuid()::text, 'companion',      300.00, true, CURRENT_TIMESTAMP)
ON CONFLICT ("service_type") DO NOTHING;
