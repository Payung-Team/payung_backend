-- Dispute audit log + dispute evidence (2 backend-only tables)
--
-- dispute_audit_logs  : timeline ของ dispute (mirror payout_status_history)
-- dispute_evidence    : ไฟล์แนบหลักฐาน (metadata + url แบบ kyc_documents; ไฟล์จริงอยู่ Supabase Storage)
--
-- ทั้งคู่ผูก booking_id -> bookings.id (UUID) ตรง ๆ (ไม่มีตาราง disputes แยก),
-- ON DELETE CASCADE (audit/evidence เป็นลูกของ booking).
-- backend-only: ไม่มี RLS / grant ให้ anon/authenticated (ตารางใหม่ที่ Prisma สร้างไม่มี grant อยู่แล้ว).

-- CreateTable
CREATE TABLE "dispute_audit_logs" (
    "id" TEXT NOT NULL,
    "booking_id" UUID NOT NULL,
    "action" TEXT NOT NULL,
    "from_status" TEXT,
    "to_status" TEXT,
    "actor_id" TEXT,
    "actor_role" TEXT,
    "note" TEXT,
    "metadata" JSONB,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "dispute_audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "dispute_evidence" (
    "id" TEXT NOT NULL,
    "booking_id" UUID NOT NULL,
    "uploaded_by" TEXT NOT NULL,
    "uploader_role" TEXT NOT NULL,
    "file_url" TEXT NOT NULL,
    "file_name" TEXT NOT NULL,
    "file_size" INTEGER NOT NULL,
    "mime_type" TEXT NOT NULL,
    "note" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "dispute_evidence_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "dispute_audit_logs_booking_id_created_at_idx"
    ON "dispute_audit_logs"("booking_id", "created_at");

-- CreateIndex
CREATE INDEX "dispute_evidence_booking_id_created_at_idx"
    ON "dispute_evidence"("booking_id", "created_at");

-- AddForeignKey
ALTER TABLE "dispute_audit_logs"
    ADD CONSTRAINT "dispute_audit_logs_booking_id_fkey"
    FOREIGN KEY ("booking_id") REFERENCES "bookings"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dispute_evidence"
    ADD CONSTRAINT "dispute_evidence_booking_id_fkey"
    FOREIGN KEY ("booking_id") REFERENCES "bookings"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
