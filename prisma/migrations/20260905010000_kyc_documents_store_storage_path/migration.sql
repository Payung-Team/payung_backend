-- ═══════════════════════════════════════════════════════════════════════════
-- PYG-307 — kyc_documents.file_url: เก็บ storage path แทน URL เต็ม
--
-- ── ทำไม ────────────────────────────────────────────────────────────────────
-- 169 จาก 170 แถวเก็บ URL รูปแบบ "public" ทั้งที่ bucket kyc-documents เป็น private:
--   https://<ref>.supabase.co/storage/v1/object/public/kyc-documents/<uid>/<file>
-- ตอนนี้ยิงแล้วได้ 400 เพราะ bucket ปิดอยู่ แต่แปลว่าถ้าวันไหนมีคนกดเปิด bucket
-- เป็น public ในหน้า dashboard รูปบัตรประชาชน 169 ใบจะเปิดโล่งทันทีที่ URL เดาได้
-- โดยไม่ต้องแก้โค้ดอะไรเลย — เก็บ path อย่างเดียวทำให้ไม่มี URL สำเร็จรูปนอนรอ
--
-- คู่กับการแก้ฝั่งโค้ด: bucket ถูกตรึงใน KYC_BUCKET ไม่แกะจากค่าที่เก็บใน DB อีก
-- และ signed URL ลดอายุจาก 3600 วิ เหลือ 900 วิ
--
-- ── DRY RUN บน staging (evsewucpighcbnhofmug) ──────────────────────────────
--   total                = 170
--   convertible (public) = 169   ← แถวที่ regex ด้านล่างจะแตะ
--   convertible (auth)   = 0
--   needs_manual         = 1
--
--   ★ แถวที่ต้องดูมือคือ id 87d7fa1c-caf2-4de5-ac0c-e4315a5c76b8
--     file_url = 'https://example.com/id-card.jpg' (doc_type=id_card_front)
--     เป็นหลักฐานว่า uploadKycDocument เคยรับ URL ภายนอกได้จริง (validate แค่ @IsUrl)
--     WHERE ด้านล่างผูกกับ host + bucket ของเราเป็น prefix จึงไม่แตะแถวนี้แน่นอน
--     จงใจไม่ลบ/ไม่แก้ในไฟล์นี้ — ให้เป็นหลักฐานของช่องโหว่ไว้ก่อน และโค้ดฝั่งอ่าน
--     จะไม่ออก signed URL ให้แถวนี้อยู่แล้ว (ไม่ตรง bucket)
--
--   ตรวจเพิ่ม: โฟลเดอร์แรกของ path ตรงกับ supabase_uid ของเจ้าของแถว 169/169
--   → ยังไม่มีใครใช้ช่องนี้ชี้ข้ามคน
--
-- deploy ด้วย `prisma migrate deploy` เท่านั้น (ห้าม migrate dev / db push)
-- ═══════════════════════════════════════════════════════════════════════════

UPDATE "kyc_documents"
SET "file_url" = regexp_replace(
      "file_url",
      '^https://evsewucpighcbnhofmug\.supabase\.co/storage/v1/object/public/kyc-documents/',
      ''
    )
WHERE "file_url" LIKE
  'https://evsewucpighcbnhofmug.supabase.co/storage/v1/object/public/kyc-documents/%';

-- ── ตรวจหลัง UPDATE: ต้องไม่เหลือ URL เต็มของ bucket นี้ ─────────────────────
DO $$
DECLARE
  leftover integer;
BEGIN
  SELECT count(*) INTO leftover
  FROM "kyc_documents"
  WHERE "file_url" LIKE '%/storage/v1/object/%kyc-documents/%';

  IF leftover > 0 THEN
    RAISE EXCEPTION
      'ยังเหลือ % แถวที่เก็บ URL เต็มอยู่ — migration ไม่ครบ ยกเลิกทั้งชุด', leftover;
  END IF;
END $$;

-- ─── guard ระดับ DB: file_url ต้องเป็น storage path เท่านั้น ─────────────────
-- validator ใน service กัน "ของใหม่" ที่จะเขียนเข้ามา
-- CHECK ตัวนี้กัน "ของเก่าที่หลุดมา" และกันเส้นทางเขียนอื่นที่อาจโผล่มาวันหลัง
-- (เช่น seed script, งาน migration ในอนาคต, หรือคนแก้มือผ่าน SQL editor)
--
-- ★ ยกเว้นแถว example.com ที่จงใจเก็บไว้เป็น fixture ของช่องโหว่
--   จึงใช้ NOT VALID: constraint มีผลกับ INSERT/UPDATE ทุกแถวตั้งแต่วินาทีนี้
--   แต่ไม่ย้อนไปตรวจแถวเดิม → แถว fixture อยู่ต่อได้โดยไม่ต้องปิดการป้องกัน
--   ถ้าวันหนึ่งลบแถวนั้นแล้ว ค่อยรัน VALIDATE CONSTRAINT เพื่อปิดให้สนิท
ALTER TABLE "kyc_documents"
  ADD CONSTRAINT "kyc_documents_file_url_is_storage_path_check"
  CHECK (
    "file_url" NOT LIKE '%://%'      -- ห้ามเป็น URL เต็ม (ทุก scheme)
    AND "file_url" NOT LIKE '%..%'   -- ห้าม path traversal
    AND "file_url" NOT LIKE '/%'     -- ห้ามขึ้นต้นด้วย /
    AND "file_url" LIKE '%/%'        -- ต้องมีโฟลเดอร์ ไม่ใช่ชื่อไฟล์ลอย ๆ
  ) NOT VALID;

-- ─── assertion: โฟลเดอร์แรกต้องเป็นของเจ้าของแถว ────────────────────────────
-- ตรวจ ณ เวลา deploy ถ้ามีแถวที่ชี้ข้ามคนอยู่ = มีคนใช้ช่องโหว่ไปแล้ว
-- ให้ migration ล้มทั้งชุด ดีกว่าปล่อยผ่านแล้วไม่มีใครเห็น
DO $$
DECLARE
  mismatched integer;
BEGIN
  SELECT count(*) INTO mismatched
  FROM "kyc_documents" d
  JOIN "users" u ON u.id = d.user_id
  WHERE d."file_url" NOT LIKE '%://%'
    AND split_part(d."file_url", '/', 1) <> u."supabase_uid";

  IF mismatched > 0 THEN
    RAISE EXCEPTION
      'พบ % แถวที่ file_url ชี้ไปโฟลเดอร์ของผู้ใช้รายอื่น — หยุด migration เพื่อตรวจสอบก่อน',
      mismatched;
  END IF;
END $$;
