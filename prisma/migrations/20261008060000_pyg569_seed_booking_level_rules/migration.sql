-- PYG-638 — [DB] ข้อมูลตั้งต้นของ booking_level_rules: 2 แถวที่เคาะแล้ว
--
-- การ์ดแม่: PYG-569 (S16 · ระบบคำนวณระดับ booking จาก ADL, Flags และบริการ แล้วใช้ค่าสูงสุด)
--
-- ⚠ เขียนมือ ห้ามรัน prisma migrate dev / db push — Sammy gate และรัน `prisma migrate deploy` เท่านั้น
-- ต้องรันหลัง 20261008050000_pyg569_booking_required_level (โครงตาราง — ขึ้น production แล้ว 8 ต.ค. 2026)
--
-- มติ 8 ต.ค. 2026:
--   1) สมองเสื่อมรุนแรง ใช้ Flag 'dementia' กรณีย่อย 'severe' → ระดับ สูง ('advanced')   (S16-R4, AC3)
--   2) กายภาพบำบัด ใช้รหัสกิจกรรม 'F03' → แถวกติการะดับว่าง = ไม่มีผลต่อระดับ           (S16-R6, AC4)
--   3) เกณฑ์ที่ 3 ของ S16 คำนวณจากระดับในตารางกิจกรรม (care_activities.care_level)
--      ยกเว้นกิจกรรมที่มีแถวในตารางกติกา (source = 'service', code = รหัสกิจกรรม) ให้ใช้ค่าจากตารางกติกาแทน
--      → F03 ใน care_activities เป็นระดับ สูง แต่แถวกติกานี้ทำให้ F03 "ไม่ดันระดับ"
--
-- ไฟล์นี้ลงเฉพาะ 2 แถวข้างบน — แถวของ Flag อื่น ๆ ยังไม่ลง รอรายการ Flags และระดับที่ยืนยันแล้ว
--   ★ ระหว่างนี้ Flag อื่นทุกตัว (รวม 'dementia' กรณีทั่วไปที่ไม่ได้ระบุว่ารุนแรง และ Flag "ไม่แน่ใจ" ที่ระบบตั้ง)
--     ยัง "ไม่มีแถว" ในตารางกติกา ซึ่งตาม S16-E7 ต้องถือเป็นข้อมูลตั้งค่าผิด ไม่ตีเป็นระดับต้นเงียบ ๆ
--
-- ที่มาของแต่ละแถว:
--   ('flag', 'dementia', 'severe', 'advanced') ← S16-R4 "Flag สมองเสื่อมที่ระบุว่าอาการรุนแรงนับเป็นระดับสูง"
--                                                + รหัส 'dementia' ตาม S08 · กรณีย่อย 'severe' ตามมติ 8 ต.ค. 2026
--   ('service', 'F03', '', NULL)               ← S16-R6 "กายภาพบำบัดไม่มีผลต่อระดับ และจองได้ทุกระดับ"
--                                                + รหัสกิจกรรม F03 ตามตาราง T-01 (care_activities.code)
--
-- idempotent: ON CONFLICT DO NOTHING — รันซ้ำไม่เกิดแถวซ้ำ และไม่เขียนทับแถวที่ถูกแก้ภายหลัง
--
-- ROLLBACK (มือ):
--   DELETE FROM "booking_level_rules"
--    WHERE ("source", "code", "variant") IN (('flag', 'dementia', 'severe'), ('service', 'F03', ''));
--   DELETE FROM "_prisma_migrations" WHERE migration_name = '20261008060000_pyg569_seed_booking_level_rules';

INSERT INTO "booking_level_rules" ("source", "code", "variant", "level") VALUES
    ('flag',    'dementia', 'severe', 'advanced'),  -- สมองเสื่อม กรณีระบุว่ารุนแรง → สูง
    ('service', 'F03',      '',       NULL)         -- กายภาพบำบัด → ไม่มีผลต่อระดับ
ON CONFLICT DO NOTHING;

-- post-assertion: 2 แถวต้องอยู่ในตาราง และรหัสกิจกรรม F03 ต้องมีจริงใน care_activities
DO $$
DECLARE
    rule_cnt INTEGER;
    f03_cnt  INTEGER;
BEGIN
    SELECT count(*) INTO rule_cnt FROM "booking_level_rules"
     WHERE ("source", "code", "variant") IN (('flag', 'dementia', 'severe'), ('service', 'F03', ''));
    SELECT count(*) INTO f03_cnt FROM "care_activities" WHERE "code" = 'F03';

    IF rule_cnt <> 2 OR f03_cnt <> 1 THEN
        RAISE EXCEPTION 'PYG-638 seed: ตั้งค่าไม่ครบ (rules=% จาก 2, care_activities ที่มีรหัส F03=%)', rule_cnt, f03_cnt;
    END IF;
END $$;
