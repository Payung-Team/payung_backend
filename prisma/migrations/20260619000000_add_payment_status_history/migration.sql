-- PYG-277: Payment status FSM — audit trail table
--
-- บันทึก "ทุกครั้ง" ที่ payment_status เปลี่ยน (from → to) พร้อมว่าใครเปลี่ยน + เพราะอะไร
-- ใช้ IF NOT EXISTS ทั้งหมด → รันซ้ำบน live DB ได้อย่างปลอดภัย (idempotent)
--
-- หมายเหตุชนิดข้อมูล:
--   payments.id = UUID  → payment_id เป็น UUID
--   users.id    = TEXT  → changed_by เป็น TEXT (users.id เก็บเป็น text ไม่ใช่ uuid)
--   from_status/to_status ใช้ enum เดิม "payment_status_enum" (สร้างไว้แล้วใน PYG-271)

CREATE TABLE IF NOT EXISTS "payment_status_history" (
  "id"          UUID                  NOT NULL DEFAULT gen_random_uuid(),
  "payment_id"  UUID                  NOT NULL,
  "from_status" "payment_status_enum",                       -- null = แถวแรกตอนสร้าง payment
  "to_status"   "payment_status_enum" NOT NULL,
  "changed_by"  TEXT,                                         -- null = ระบบ/cron เป็นผู้เปลี่ยน
  "reason"      TEXT,
  "metadata"    JSONB,
  "created_at"  TIMESTAMPTZ           NOT NULL DEFAULT now(),
  CONSTRAINT "payment_status_history_pkey" PRIMARY KEY ("id"),
  -- ลบ payment → ลบ history ตามไปด้วย (cascade)
  CONSTRAINT "fk_psh_payment"
    FOREIGN KEY ("payment_id") REFERENCES "payments"("id") ON DELETE CASCADE ON UPDATE NO ACTION,
  -- ลบ user ที่เคยเปลี่ยนสถานะ → เก็บ history ไว้แต่ set changed_by เป็น null
  CONSTRAINT "fk_psh_changed_by"
    FOREIGN KEY ("changed_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE NO ACTION
);

-- index สำหรับ query "ดึง history ทั้งหมดของ payment หนึ่งใบ" (paymentHistory)
CREATE INDEX IF NOT EXISTS "idx_psh_payment"
  ON "payment_status_history"("payment_id");
