-- PYG-638 — [DB] ข้อมูลตั้งต้นของ booking_level_rules: ระดับของ Flags (เกณฑ์ที่ 2) 10 แถว
--
-- การ์ดแม่: PYG-569 (S16 · ระบบคำนวณระดับ booking จาก ADL, Flags และบริการ แล้วใช้ค่าสูงสุด)
--
-- ⚠ เขียนมือ ห้ามรัน prisma migrate dev / db push — Sammy gate และรัน `prisma migrate deploy` เท่านั้น
-- ต่อจาก 20261008060000_pyg569_seed_booking_level_rules (2 แถวแรก — ขึ้น production แล้ว 8 ต.ค. 2026)
--
-- ที่มาของข้อมูล: รายการ Flags จาก infographic ล่าสุด (เกณฑ์ที่ 2) ตามที่ทีมส่งมา 8 ต.ค. 2026
--   คัดตรง ๆ ไม่เพิ่ม ไม่ตัด · 10 แถว source = 'flag': สูง 6 / กลาง 4
--   การ map ระดับ: กลาง = 'intermediate' · สูง = 'advanced'
--
-- รหัส (code): เป็นชุดรหัสที่เสนอในรอบนี้ — S08 กำหนดไว้ก่อนหน้าแค่ 'dementia'
--   ทุกฝั่งต้องใช้ชุดเดียวกัน: แจ้งไว้ในการ์ด PYG-607 (API) และ PYG-609 (BE) แล้ว
--   ค่าใน care_recipient_assessments.flags ต้องสะกดตรงกับ code ในไฟล์นี้ทุกตัวอักษร
--
-- หมายเหตุรายแถว:
--   • 'dementia' กรณีทั่วไป (variant = '') = กลาง — คู่กับแถว ('flag','dementia','severe') = สูง ที่ลงไปแล้ว
--   • 'unsure' — Flag ที่ระบบตั้งเองเมื่อญาติตอบ "ไม่แน่ใจ" ตั้งแต่ 3 ข้อ (S16-E6)
--       ★ ค่านี้ "ไม่ได้อยู่" ในคอลัมน์ flags — ระบบเก็บเป็น care_recipient_assessments.has_unsure_flag
--         BE ต้องแปลง has_unsure_flag = true เป็นรหัส 'unsure' ตอนคำนวณ (แจ้งไว้ใน PYG-639)
--   • "ไม่มีเงื่อนไขพิเศษ" ไม่มีแถว — เก็บเป็น no_special_conditions ไม่ได้อยู่ในรายการ Flags (S16-E2)
--   • แถว ('service','F03') ของกายภาพบำบัดไม่ถูกแตะ — คงไว้ก่อน รอ Sammy เคาะว่ากายภาพบำบัดมีผลต่อระดับหรือไม่
--
-- หลังไฟล์นี้ ตารางกติกามี 12 แถว: flag 11 (สูง 7 / กลาง 4) + service 1 (ไม่มีผล)
--
-- idempotent: ON CONFLICT DO NOTHING — รันซ้ำไม่เกิดแถวซ้ำ และไม่เขียนทับแถวที่ถูกแก้ภายหลัง
--
-- ROLLBACK (มือ):
--   DELETE FROM "booking_level_rules"
--    WHERE "source" = 'flag' AND "variant" = ''
--      AND "code" IN ('ng_tube', 'urinary_catheter', 'oxygen', 'pressure_ulcer', 'injection', 'end_of_life', 'dementia', 'diabetes', 'fall_risk', 'unsure');
--   DELETE FROM "_prisma_migrations" WHERE migration_name = '20261008070000_pyg569_seed_flag_level_rules';

INSERT INTO "booking_level_rules" ("source", "code", "variant", "level") VALUES
    ('flag', 'ng_tube',          '', 'advanced'),  -- ใช้สายยางให้อาหาร → สูง
    ('flag', 'urinary_catheter', '', 'advanced'),  -- ใช้สายสวนปัสสาวะ → สูง
    ('flag', 'oxygen',           '', 'advanced'),  -- ใช้ออกซิเจนหรือเครื่องช่วยหายใจ → สูง
    ('flag', 'pressure_ulcer',   '', 'advanced'),  -- มีแผลกดทับ → สูง
    ('flag', 'injection',        '', 'advanced'),  -- ต้องฉีดยา → สูง
    ('flag', 'end_of_life',      '', 'advanced'),  -- อยู่ในระยะท้าย → สูง
    ('flag', 'dementia',         '', 'intermediate'),  -- สมองเสื่อมหรืออัลไซเมอร์ (ไม่มีกรณีย่อย) → กลาง
    ('flag', 'diabetes',         '', 'intermediate'),  -- เบาหวานที่ต้องเจาะน้ำตาลหรือคุมอาหาร → กลาง
    ('flag', 'fall_risk',        '', 'intermediate'),  -- เสี่ยงหกล้มหรือเคยล้มใน 6 เดือน → กลาง
    ('flag', 'unsure',           '', 'intermediate')  -- ญาติตอบ "ไม่แน่ใจ" ตั้งแต่ 3 ข้อ (ระบบตั้งเอง) → กลาง
ON CONFLICT DO NOTHING;

-- post-assertion: 10 แถวต้องอยู่ในตาราง (ไม่ว่าเพิ่งใส่หรือมีอยู่ก่อน)
DO $$
DECLARE
    rule_cnt INTEGER;
BEGIN
    SELECT count(*) INTO rule_cnt FROM "booking_level_rules"
     WHERE "source" = 'flag' AND "variant" = ''
       AND "code" IN ('ng_tube', 'urinary_catheter', 'oxygen', 'pressure_ulcer', 'injection', 'end_of_life', 'dementia', 'diabetes', 'fall_risk', 'unsure');

    IF rule_cnt <> 10 THEN
        RAISE EXCEPTION 'PYG-638 seed flags: พบกติกาของ Flag % จาก 10 รายการ', rule_cnt;
    END IF;
END $$;
