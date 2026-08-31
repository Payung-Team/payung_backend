-- PYG-352 — Monitoring: job_events + bookings.review_reasons + realtime/RLS + storage bucket
--
-- การ์ดแม่: PYG-351 (Caregiver Check-in at Job Start)
--
-- ⚠ ไฟล์นี้ "เขียนมือ" ตามกติกาของทีม — ห้ามรัน prisma migrate dev / db push
--   คนเดียวที่รัน `prisma migrate deploy` คือ Sam เท่านั้น
--
-- สิ่งที่ไฟล์นี้ทำ:
--   1. เช็คก่อนว่ามี CHECK constraint บน bookings.status หรือไม่ (จะได้รู้ว่า status ใหม่จะโดนบล็อกไหม)
--   2. CREATE TABLE job_events
--   3. ALTER TABLE bookings ADD COLUMN review_reasons
--   4. เปิด realtime (publication) ให้ job_events
--   5. เปิด RLS + policy SELECT อย่างเดียว
--   6. สร้าง storage bucket 'job-evidence' (แบบ private)
--
-- สิ่งที่ไฟล์นี้ "ไม่" ทำ (ตั้งใจ):
--   ✗ ไม่มีคอลัมน์ within_radius — เก็บแค่ distance_m ดิบ ๆ แล้วตัดสินตอนอ่าน
--     (ถ้าเก็บ boolean ไว้ backend จะใช้ 200 ม. แต่ verdict ใช้ 500 ม. → เถียงกันตลอดกาล)
--   ✗ ไม่มี ALTER TYPE — bookings.status เป็น TEXT อยู่แล้ว ค่าใหม่จึงใช้ได้ทันที
--   ✗ ไม่เพิ่ม location_lat / location_lng — สองคอลัมน์นี้มีอยู่แล้วตั้งแต่ก่อนหน้านี้

-- ─── 1. เช็ค CHECK constraint บน bookings (STEP 2.1b ของการ์ด) ────────────────
-- ถ้ามี CHECK constraint คุม status อยู่ ค่าใหม่ ('in_progress' ฯลฯ) จะถูก reject เงียบ ๆ
-- DO block นี้ไม่แก้อะไร แค่ขึ้น NOTICE ตอน deploy ให้คนรัน migrate เห็น
DO $$
DECLARE
    con RECORD;
BEGIN
    FOR con IN
        SELECT conname, pg_get_constraintdef(oid) AS def
        FROM pg_constraint
        WHERE conrelid = 'bookings'::regclass AND contype = 'c'
    LOOP
        RAISE NOTICE 'PYG-352: พบ CHECK constraint บน bookings → % : %', con.conname, con.def;
    END LOOP;
END $$;

-- ─── 2. CreateTable job_events ────────────────────────────────────────────────
-- 1 booking มีได้อย่างมาก 2 แถว: check_in หนึ่งแถว + check_out หนึ่งแถว
CREATE TABLE "job_events" (
    "id"          UUID NOT NULL DEFAULT gen_random_uuid(),
    "booking_id"  UUID NOT NULL,
    "caregiver_id" TEXT NOT NULL,

    -- ประเภทเหตุการณ์
    "event_type"  TEXT NOT NULL,
    -- ใครเป็นคนสร้างแถวนี้: 'caregiver' = ผู้ดูแลกดเอง, 'system' = cron กวาดปิดให้ (PYG-359)
    -- verdict='valid' บังคับว่า check_out ต้อง source='caregiver' เท่านั้น
    "source"      TEXT NOT NULL,

    -- พิกัด: NULL ได้ เพราะผู้ดูแล "ปฏิเสธสิทธิ์ตำแหน่ง" แล้วยังต้องเช็คอินได้อยู่
    "lat"         DECIMAL(10,7),
    "lng"         DECIMAL(10,7),

    -- ระยะห่างจากจุดงาน หน่วยเมตร — เก็บค่าดิบเท่านั้น ไม่เก็บ boolean
    -- NULL = คำนวณไม่ได้ (ไม่มีพิกัดฝั่งใดฝั่งหนึ่ง) → ห้ามตีความว่า "ผิด"
    "distance_m"  INTEGER,

    -- ★ ความแม่นยำของตำแหน่ง (เมตร) จาก position.coords.accuracy ของ browser
    -- คอลัมน์นี้เกิดขึ้นเพราะโปรดักต์เปลี่ยนจาก mobile app เป็น web app:
    -- เบราว์เซอร์บนเดสก์ท็อปไม่มีชิป GPS ต้องเดาจาก Wi-Fi/IP ซึ่งคลาดเคลื่อนได้เป็นกิโลเมตร
    -- ค่านี้คือสิ่งที่ตัดสินว่า distance_m "เชื่อถือได้หรือไม่"
    "accuracy_m"  INTEGER,

    -- เวลาของเซิร์ฟเวอร์ = เวลาจริงเพียงแหล่งเดียว (ห้ามเชื่อนาฬิกาเครื่อง client)
    "server_ts"   TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    -- เวลาที่เครื่อง client บอกมา — เก็บเป็น metadata เฉย ๆ ใช้จับ clock_anomaly
    "device_ts"   TIMESTAMPTZ(6),

    -- สองคอลัมน์นี้ใช้ตอน check_out (PYG-358) — check_in ปล่อย NULL
    "note"        TEXT,
    "photo_url"   TEXT,

    "created_at"  TIMESTAMPTZ(6) NOT NULL DEFAULT now(),

    CONSTRAINT "job_events_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "job_events_event_type_check" CHECK ("event_type" IN ('check_in', 'check_out')),
    CONSTRAINT "job_events_source_check"     CHECK ("source"     IN ('caregiver', 'system'))
);

-- ★ กดปุ่มซ้ำแล้วไม่พัง — UNIQUE นี้คือสิ่งที่การันตี AC ข้อ 8
CREATE UNIQUE INDEX "job_events_booking_id_event_type_key"
    ON "job_events"("booking_id", "event_type");

CREATE INDEX "job_events_booking_id_idx" ON "job_events"("booking_id");

-- ─── 3. AddForeignKey ─────────────────────────────────────────────────────────
-- booking_id → bookings.id (UUID ↔ UUID). CASCADE: ลบ booking แล้วหลักฐานไม่ต้องค้าง
ALTER TABLE "job_events" ADD CONSTRAINT "job_events_booking_id_fkey"
    FOREIGN KEY ("booking_id") REFERENCES "bookings"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

-- caregiver_id → caregivers.id (TEXT ↔ TEXT). RESTRICT: ห้ามลบ caregiver ทิ้งหลักฐานงาน
ALTER TABLE "job_events" ADD CONSTRAINT "job_events_caregiver_id_fkey"
    FOREIGN KEY ("caregiver_id") REFERENCES "caregivers"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

-- ─── 4. AlterTable bookings: review_reasons ───────────────────────────────────
-- เก็บ "เหตุผลที่ต้องรีวิว" เป็น array ของ string เช่น {'out_of_radius','clock_anomaly'}
-- array ว่าง = ไม่มีธงอะไรเลย ซึ่งเป็นเงื่อนไขหนึ่งของ verdict='valid'
-- NOT NULL DEFAULT '{}' → booking เก่าทุกใบได้ array ว่างทันที ไม่ต้อง backfill
ALTER TABLE "bookings" ADD COLUMN "review_reasons" TEXT[] NOT NULL DEFAULT '{}';

-- หมายเหตุ: ไม่มี ALTER TYPE ตรงนี้ เพราะ bookings.status เป็น TEXT
-- ค่าใหม่ 'in_progress' / 'awaiting_release' / 'needs_review' จึงเขียนลงไปได้เลย

-- ─── 5. Realtime: เพิ่ม job_events เข้า publication ───────────────────────────
-- ลืมขั้นตอนนี้ = หน้า "ติดตามการทำงาน" ของผู้รับบริการจะเงียบสนิท
-- ไม่มี error ไม่มีข้อมูล — debug ยากมาก
-- ห่อ DO block ไว้เพราะถ้าตารางอยู่ใน publication แล้ว ALTER จะ error และทำ migration ล้มทั้งไฟล์
DO $$
BEGIN
    ALTER PUBLICATION supabase_realtime ADD TABLE "job_events";
EXCEPTION
    WHEN duplicate_object THEN
        RAISE NOTICE 'PYG-352: job_events อยู่ใน supabase_realtime อยู่แล้ว — ข้าม';
    WHEN undefined_object THEN
        RAISE NOTICE 'PYG-352: ไม่พบ publication supabase_realtime (ปกติบน local ที่ไม่ใช่ Supabase) — ข้าม';
END $$;

-- ─── 6. RLS ───────────────────────────────────────────────────────────────────
-- ลอกแพตเทิร์นมาจาก migration 20260424100000 (ตาราง notifications) ตรง ๆ ตามที่การ์ดสั่ง
-- backend ไม่กระทบ เพราะ Prisma ต่อด้วย role postgres (เจ้าของตาราง) ซึ่ง bypass RLS
-- และรีโปนี้ไม่มี FORCE ROW LEVEL SECURITY อยู่ที่ไหนเลย
ALTER TABLE "job_events" ENABLE ROW LEVEL SECURITY;

-- Policy เดียวเท่านั้น: SELECT ให้คู่กรณีของ booking นั้น (ผู้รับบริการ + ผู้ดูแล)
-- auth.uid() = Supabase Auth uid → map กลับมาเป็น users.id ผ่าน users.supabase_uid
CREATE POLICY "job_events_select_participants" ON "job_events"
    FOR SELECT
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
--   หลักฐานการทำงานต้องเขียนจาก backend เท่านั้น ไม่งั้นผู้ดูแลแก้ระยะทางตัวเองได้

-- ─── 7. Storage bucket 'job-evidence' ─────────────────────────────────────────
-- ทำเป็น SQL ในไฟล์ ไม่ใช่ไปกดในหน้า dashboard
-- (โปรเจกต์นี้มี 12 object ที่อยู่ใน DB แต่ไม่อยู่ใน migration เพราะกดมือ — อย่าเพิ่มอีก)
--
-- ห่อ EXCEPTION ไว้ทั้งก้อน: บาง environment (local postgres ที่ไม่ใช่ Supabase)
-- ไม่มี schema `storage` เลย ถ้าไม่ห่อ migration จะล้มทั้งไฟล์
DO $$
BEGIN
    INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
    VALUES (
        'job-evidence',
        'job-evidence',
        false,                              -- private เท่านั้น อ่านผ่าน signed URL
        5242880,                            -- 5 MB
        ARRAY['image/jpeg', 'image/png']    -- allowlist: JPG / PNG เท่านั้น
    )
    ON CONFLICT (id) DO NOTHING;

    RAISE NOTICE 'PYG-352: bucket job-evidence พร้อมใช้งาน';
EXCEPTION
    WHEN undefined_table OR insufficient_privilege THEN
        RAISE NOTICE 'PYG-352: สร้าง bucket ผ่าน SQL ไม่ได้ใน environment นี้ — ให้ Sam สร้างด้วยมือ (private, 5MB, image/jpeg+image/png)';
END $$;

-- Storage policy: อ่านไฟล์ได้เฉพาะคู่กรณีของ booking นั้น
-- path convention = {bookingId}/{eventType}-{timestamp}.jpg
-- ดังนั้น segment แรกของ path คือ booking id → เอามาเทียบสิทธิ์ได้เลย
DO $$
BEGIN
    EXECUTE $policy$
        CREATE POLICY "job_evidence_select_participants" ON storage.objects
            FOR SELECT
            USING (
                bucket_id = 'job-evidence'
                AND (storage.foldername(name))[1] IN (
                    SELECT b.id::text
                    FROM bookings b
                    LEFT JOIN caregivers c ON c.id = b.caregiver_id
                    WHERE b.patient_id IN (SELECT id FROM users WHERE supabase_uid = auth.uid()::text)
                       OR c.user_id     IN (SELECT id FROM users WHERE supabase_uid = auth.uid()::text)
                )
            )
    $policy$;
EXCEPTION
    WHEN duplicate_object THEN
        RAISE NOTICE 'PYG-352: policy job_evidence_select_participants มีอยู่แล้ว — ข้าม';
    WHEN undefined_table OR insufficient_privilege THEN
        RAISE NOTICE 'PYG-352: ตั้ง storage policy ไม่ได้ใน environment นี้ — ให้ Sam ตั้งด้วยมือ';
END $$;
