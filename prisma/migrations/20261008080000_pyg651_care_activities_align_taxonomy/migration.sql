-- PYG-651 follow-up: align care_activities with the Caregiver Service Taxonomy (Phase ทดลอง)
-- Hand-written. Deploy only via `prisma migrate deploy` after Sammy approves.
-- Safe to re-run: UPDATEs match on code + old value, INSERTs skip existing rows.
-- Checked 2026-10-08 (read-only): booking_activities has 0 rows, so no existing booking is affected.
-- Prisma: add model CareActivityProfession (table care_activity_professions) to schema.prisma in the same PR.

BEGIN;

-- 1) Level changes (8 rows)
UPDATE care_activities SET care_level = 'intermediate', updated_at = now()
 WHERE code = 'A01' AND care_level = 'basic';          -- อาบน้ำ: ต้น -> กลาง

UPDATE care_activities SET care_level = 'basic', updated_at = now()
 WHERE code = 'A02' AND care_level = 'intermediate';   -- เช็ดตัว: กลาง -> ต้น

UPDATE care_activities SET care_level = 'intermediate', updated_at = now()
 WHERE code = 'A03' AND care_level = 'basic';          -- ช่องปาก/ฟันปลอม: ต้น -> กลาง

UPDATE care_activities SET care_level = 'basic', updated_at = now()
 WHERE code = 'D02' AND care_level = 'intermediate';   -- จัดยาตามแพทย์สั่ง: กลาง -> ต้น

UPDATE care_activities
   SET care_level = 'intermediate',
       name_th    = 'วัดสัญญาณชีพครบชุด (ความดัน ชีพจร อุณหภูมิ การหายใจ) และบันทึก',
       updated_at = now()
 WHERE code = 'E01' AND care_level = 'basic';          -- วัดสัญญาณชีพครบชุด: ต้น -> กลาง

UPDATE care_activities SET care_level = 'advanced', updated_at = now()
 WHERE code = 'E03' AND care_level = 'intermediate';   -- ออกซิเจน: กลาง -> สูง (ตรง Flag oxygen = สูง)

UPDATE care_activities
   SET care_level = 'intermediate',
       name_th    = 'ทำแผลทั่วไป (แผลเล็ก แผลตื้น ไม่ติดเชื้อ)',
       updated_at = now()
 WHERE code = 'E06' AND care_level = 'advanced';       -- ทำแผลทั่วไป: สูง -> กลาง (แผลกดทับรุนแรงแยกไป E11)

UPDATE care_activities SET care_level = 'intermediate', updated_at = now()
 WHERE code = 'F04' AND care_level = 'basic';          -- กิจกรรมกระตุ้นความจำ: ต้น -> กลาง

-- 2) Split dementia care: G02 stays กลาง (ป้องกันพลัดหลง); behaviour handling becomes G04 สูง
UPDATE care_activities
   SET name_th    = 'ดูแลผู้มีภาวะสมองเสื่อม ป้องกันการพลัดหลง',
       updated_at = now()
 WHERE code = 'G02';

-- 3) New activities from the Taxonomy (15 rows, incl. new category J "ประเมินและประสานงาน")
INSERT INTO care_activities (code, name_th, category, care_level, sort_order) VALUES
  ('A10', 'โกนหนวด',                                     'สุขอนามัยส่วนบุคคล',        'basic',         95),
  ('C05', 'ดูแลโภชนาการ วางแผนมื้ออาหารตามโรค',             'อาหารและโภชนาการ',          'intermediate', 185),
  ('E08', 'ปฐมพยาบาลเบื้องต้นและ CPR / AED',                'การเฝ้าระวังสุขภาพ',         'intermediate', 262),
  ('E09', 'ป้องกันการติดเชื้อ (ล้างมือ จัดการของปนเปื้อน)',      'การเฝ้าระวังสุขภาพ',         'intermediate', 264),
  ('E10', 'ทำแผลถลอก ล้างแผลด้วยน้ำเกลือ ประคบร้อนเย็น',       'การพยาบาลเฉพาะ',            'basic',        285),
  ('E11', 'ทำแผลกดทับรุนแรง (ไม่รวมระดับ 4 หรือแผลติดเชื้อ)',  'การพยาบาลเฉพาะ',            'advanced',     305),
  ('G04', 'รับมือพฤติกรรมผู้ป่วยสมองเสื่อม',                   'ความปลอดภัยและการเฝ้าดู',     'advanced',     365),
  ('H04', 'สอนใช้มือถือ วิดีโอคอลกับครอบครัว',                 'เพื่อนและสังคม',             'basic',        402),
  ('H05', 'ดูแลอารมณ์ (เหงา ซึม)',                           'เพื่อนและสังคม',             'intermediate', 404),
  ('H06', 'จัดการเอกสารและสิทธิการรักษา',                      'เพื่อนและสังคม',             'intermediate', 406),
  ('J01', 'ประเมินความเสี่ยงตาม checklist',                   'ประเมินและประสานงาน',        'intermediate', 440),
  ('J02', 'สอนญาติทำกิจวัตรพื้นฐาน',                          'ประเมินและประสานงาน',        'intermediate', 450),
  ('J03', 'ประเมินอาการและทำ care plan',                      'ประเมินและประสานงาน',        'advanced',     460),
  ('J04', 'สอนญาติงานทางคลินิก',                             'ประเมินและประสานงาน',        'advanced',     470),
  ('J05', 'ประสานแพทย์หรือนักกายภาพ',                         'ประเมินและประสานงาน',        'advanced',     480)
ON CONFLICT (code) DO NOTHING;

-- 4) Profession lock: which professions may do an activity.
--    No row for an activity = no lock. Values match caregivers.profession.
CREATE TABLE IF NOT EXISTS care_activity_professions (
  care_activity_id uuid        NOT NULL REFERENCES care_activities(id) ON UPDATE CASCADE ON DELETE CASCADE,
  profession       text        NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT care_activity_professions_pkey PRIMARY KEY (care_activity_id, profession),
  CONSTRAINT care_activity_professions_profession_check
    CHECK (profession = ANY (ARRAY['general_caregiver'::text, 'nurse'::text, 'physiotherapist'::text]))
);

-- Same as care_activities: RLS on, no policies (backend reads via Prisma).
ALTER TABLE care_activity_professions ENABLE ROW LEVEL SECURITY;

INSERT INTO care_activity_professions (care_activity_id, profession)
SELECT ca.id, v.profession
  FROM (VALUES
    -- existing advanced activities: lock as written in T-01 (no PN in system yet -> nurse only)
    ('A08', 'nurse'),             -- สายสวนปัสสาวะ
    ('A09', 'nurse'),             -- ถุงอุจจาระหน้าท้อง
    ('C04', 'nurse'),             -- ให้อาหารทางสายยาง
    ('D05', 'nurse'),             -- ฉีดยา
    ('E03', 'nurse'),             -- ออกซิเจน (เพิ่งขึ้นเป็นระดับสูง)
    ('E04', 'nurse'),             -- ดูดเสมหะ
    ('E05', 'nurse'),             -- ท่อเจาะคอ
    ('E07', 'nurse'),             -- แผลหน้าท้อง
    ('F03', 'physiotherapist'),   -- กายภาพบำบัด
    -- new advanced activities
    ('E11', 'nurse'),             -- แผลกดทับรุนแรง
    ('G04', 'nurse'),             -- รับมือพฤติกรรมสมองเสื่อม
    ('J03', 'nurse'),             -- ประเมินอาการและทำ care plan
    ('J03', 'physiotherapist'),
    ('J04', 'nurse'),             -- สอนญาติงานทางคลินิก
    ('J04', 'physiotherapist'),
    ('J05', 'nurse')              -- ประสานแพทย์หรือนักกายภาพ
  ) AS v(code, profession)
  JOIN care_activities ca ON ca.code = v.code
ON CONFLICT DO NOTHING;

COMMIT;
