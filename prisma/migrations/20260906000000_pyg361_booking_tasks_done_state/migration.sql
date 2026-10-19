-- PYG-361 — Live task-completion state for booking_tasks + RLS lockdown + realtime
--
-- การ์ดแม่: PYG-352/358 (proof-of-work), PYG-350 (booking tracking)
--
-- ⚠ ไฟล์นี้ "เขียนมือ" ตามกติกาของทีม — ห้ามรัน prisma migrate dev / db push
--   คนเดียวที่รัน `prisma migrate deploy` คือ Sammy เท่านั้น
--
-- สิ่งที่ไฟล์นี้ทำ:
--   1. ALTER TABLE booking_tasks ADD COLUMN done_at, done_by (+ FK ไปที่ caregivers)
--      ⚠ หมายเหตุ: สอง column นี้มีอยู่ใน live DB แล้ว โดยถูก apply ผ่าน Supabase CLI/dashboard
--        (มีชื่ออยู่ใน supabase_migrations.schema_migrations ว่า
--         20260829132846_add_done_columns_to_booking_tasks) แต่ "ไม่มี" ใน _prisma_migrations
--        และไม่มีไฟล์ในรีโป — เป็น schema drift คลาสเดียวกับที่ทีมกำลังไล่เก็บอยู่
--        ใช้ ADD COLUMN IF NOT EXISTS เพื่อให้ migrate deploy ไม่ล้ม และ track ไฟล์ไว้ในรีโป
--   2. Backfill: booking_tasks มี 0 แถวตอนนี้ ทั้งที่มี booking จำนวนมากที่ bookings.tasks (TEXT[])
--      ไม่ว่างอยู่ — เติมแถวให้ครบจาก array เดิม โดยรักษาลำดับเป็น sort_order
--   3. ปิดช่องโหว่ RLS: booking_tasks_patient_manage (ALL, ให้ patient เขียนตรงได้!) ต้องถูกลบ
--      เพราะ decision ของ PYG-361 คือ "เขียนได้ผ่าน backend เท่านั้น" (Prisma role=postgres bypass RLS)
--   4. เปิด realtime (publication) ให้ booking_tasks — หน้าติดตามงานของผู้รับบริการรอ ping จากตารางนี้
--
-- สิ่งที่ไฟล์นี้ "ไม่" ทำ (ตั้งใจ):
--   ✗ ไม่ยุ่งกับ current_user_id() / is_admin_or_super() — สอง function นี้ไม่มีอยู่ในไฟล์ migration
--     ไหนเลย (ghost objects) แต่ยังมีตารางอื่นอาจอ้างอิงอยู่ ไฟล์นี้แค่ "เลิกพึ่งพา" มันสำหรับ
--     ตารางนี้โดยการลบ policy ที่ใช้มัน ไม่ได้ DROP FUNCTION ทิ้ง (นอกขอบเขตของการ์ดนี้)
--   ✗ ไม่มี ALTER TYPE — booking_tasks ไม่มีคอลัมน์ status/enum ใด ๆ
--   ✗ ไม่ GRANT USAGE/SELECT ให้ authenticated/anon — เป็นการตัดสินใจของทีมทั้งหมด (คุยหลังเดโม)
--     ไม่ใช่เรื่องที่ migration ของการ์ดนี้จะแอบใส่เอง — patient ยังเห็นข้อมูลผ่าน poll 30 วิเหมือนเดิม

-- ─── 1. AlterTable booking_tasks: done_at / done_by ────────────────────────────
-- done_at เป็น TIMESTAMPTZ ที่ nullable แทนที่จะเป็น boolean "is_done": ให้แอดมินเห็นได้ว่า
-- ทำ "เมื่อไหร่" ไม่ใช่แค่ทำหรือยัง และรองรับการ "ยกเลิกติ๊ก" กลับเป็น NULL ได้ตรง ๆ
ALTER TABLE "booking_tasks"
    ADD COLUMN IF NOT EXISTS "done_at" TIMESTAMPTZ(6),
    ADD COLUMN IF NOT EXISTS "done_by" TEXT;

-- done_by → caregivers.id (TEXT ↔ TEXT, ไม่ใช่ UUID — caregivers.id เป็น TEXT ธรรมดา)
-- ON DELETE SET NULL: ลบ caregiver แล้วไม่ต้องลาก booking_tasks ไปด้วย แค่เคลียร์ผู้ทำ
-- ON UPDATE CASCADE: เผื่อ caregivers.id ถูกเปลี่ยน (ปกติไม่เกิด แต่ตามธรรมเนียม FK อื่นในไฟล์นี้)
DO $$
BEGIN
    ALTER TABLE "booking_tasks" ADD CONSTRAINT "booking_tasks_done_by_fkey"
        FOREIGN KEY ("done_by") REFERENCES "caregivers"("id")
        ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION
    WHEN duplicate_object THEN
        RAISE NOTICE 'PYG-361: booking_tasks_done_by_fkey มีอยู่แล้ว — ข้าม';
END $$;

-- ─── 2. Backfill: bookings.tasks (TEXT[]) → booking_tasks rows ─────────────────
-- booking_tasks มี 0 แถวตอนนี้ ทั้งที่หลาย booking มี tasks ไม่ว่าง — เติมให้ครบ
-- WITH ORDINALITY รักษาลำดับเดิมของ array ไว้เป็น sort_order (0-based)
-- NOT EXISTS ต่อ booking กันไม่ให้รันซ้ำแล้วซ้ำแถว (idempotent) และไม่ชนกับ booking ที่ถูกสร้าง
-- ผ่านโค้ดใหม่ (BookingService.createBooking ที่เขียน booking_tasks เองแล้วตั้งแต่ตอนสร้าง)
-- is_suggested/is_custom ไม่ทราบได้จาก array เดิม (ข้อมูลนี้หายไปตั้งแต่ต้น ไม่เคยถูกเก็บแยก)
-- จึงใส่ false/true (ปฏิบัติเหมือน custom ทั้งหมด) — ไม่กระทบ AC ของการ์ดนี้ เพราะ FE ไม่ได้ใช้
-- สองฟิลด์นี้แยกสีในหน้าติดตามงาน
--
-- จำนวนแถวที่คาดว่าจะ insert = sum(cardinality(tasks)) ของ booking ที่ยังไม่มีแถวใน booking_tasks
-- ไม่ใช่จำนวน booking — 1 booking มีได้หลาย task (ดูตัวเลข dry-run ในหัว PR)
INSERT INTO "booking_tasks" ("booking_id", "description", "is_suggested", "is_custom", "sort_order")
SELECT b.id, t.description, false, true, (t.ord - 1)::int
FROM "bookings" b
CROSS JOIN LATERAL unnest(b.tasks) WITH ORDINALITY AS t(description, ord)
WHERE cardinality(b.tasks) > 0
  AND NOT EXISTS (SELECT 1 FROM "booking_tasks" bt WHERE bt.booking_id = b.id);

-- ─── 3. RLS: ปิดช่องโหว่ "patient เขียนตรงได้" + เลิกพึ่งพา ghost function ───────
-- booking_tasks_patient_manage (cmd=ALL) ให้ patient เขียนตารางนี้ตรง ๆ ผ่าน Supabase client
-- ได้ — ขัดกับ decision ของ PYG-361 ("เขียนได้ผ่าน backend เท่านั้น") ต้องลบทิ้ง
--
-- ★ ลบทั้ง 3 policy รวมถึง booking_tasks_select ที่ดูรูปแบบถูกต้องอยู่แล้ว เพราะไม่มีตัวไหนเลย
--   ที่ track อยู่ในไฟล์ migration ใด ๆ (ทั้งหมดถูกสร้างผ่าน Supabase dashboard) — สร้างใหม่
--   ในไฟล์นี้เพื่อให้ track ได้จริง ตามที่การ์ด Section 2 + STEP 3.2 สั่งไว้ตรง ๆ
DROP POLICY IF EXISTS "booking_tasks_select" ON "booking_tasks";
DROP POLICY IF EXISTS "booking_tasks_patient_manage" ON "booking_tasks";
DROP POLICY IF EXISTS "booking_tasks_admin" ON "booking_tasks";

ALTER TABLE "booking_tasks" ENABLE ROW LEVEL SECURITY;

-- Policy เดียวเท่านั้น: SELECT ให้คู่กรณีของ booking นั้น (ผู้รับบริการ + ผู้ดูแล)
-- คัดลอก subquery แบบ literal มาจาก migration ของ job_events — ตั้งใจไม่ใช้
-- current_user_id()/is_admin_or_super() เพราะทั้งคู่เป็น ghost function ที่ไม่อยู่ใน migration
-- TO authenticated ใส่ไว้ชัดเจน (ของเดิมอย่าง job_events ไม่ได้ใส่ไว้ — เป็นช่องโหว่เล็กที่หลุดไป
-- ไม่กระทบความถูกต้องเพราะ auth.uid() เป็น NULL สำหรับ anon อยู่แล้ว แต่ใส่ชัดเจนไว้ดีกว่า)
CREATE POLICY "booking_tasks_select_participants" ON "booking_tasks"
    FOR SELECT
    TO authenticated
    USING (
        booking_id IN (
            SELECT b.id
            FROM bookings b
            LEFT JOIN caregivers c ON c.id = b.caregiver_id
            WHERE b.patient_id IN (SELECT id FROM users WHERE supabase_uid = auth.uid()::text)
               OR c.user_id     IN (SELECT id FROM users WHERE supabase_uid = auth.uid()::text)
        )
    );

-- ★ ตั้งใจไม่สร้าง policy INSERT / UPDATE / DELETE สำหรับ client
--   ต้องเขียนจาก backend เท่านั้น ไม่งั้นผู้รับบริการแก้สถานะติ๊กงานเองได้

-- ─── 4. Realtime: เพิ่ม booking_tasks เข้า publication ─────────────────────────
-- ลืมขั้นตอนนี้ = หน้าติดตามงานของผู้รับบริการจะไม่ push ให้เลย ไม่มี error ไม่มีข้อมูล
-- ห่อ DO block ไว้เพราะถ้าตารางอยู่ใน publication แล้ว ALTER จะ error และทำ migration ล้มทั้งไฟล์
-- insufficient_privilege ต้องดักด้วย: publication supabase_realtime เจ้าของคือ supabase_admin
-- ไม่ใช่ postgres ถ้าโดนปฏิเสธจะไม่ใช่ duplicate_object และไม่ใช่ undefined_object
DO $$
BEGIN
    ALTER PUBLICATION supabase_realtime ADD TABLE "booking_tasks";
EXCEPTION
    WHEN duplicate_object THEN
        RAISE NOTICE 'PYG-361: booking_tasks อยู่ใน supabase_realtime อยู่แล้ว — ข้าม';
    WHEN undefined_object THEN
        RAISE NOTICE 'PYG-361: ไม่พบ publication supabase_realtime — ข้าม';
    WHEN insufficient_privilege THEN
        RAISE NOTICE 'PYG-361: ไม่มีสิทธิ์แก้ publication supabase_realtime — ข้าม';
END $$;
