-- PYG-627: seed service packages for Phase ทดลอง (approved by Sammy 2026-10-09)
-- 4 packages, 9 items, 6 group mappings (each group sees 2 packages).
-- Hand-written. Deploy only via `prisma migrate deploy` after Sammy approves.
-- Safe to re-run: ON CONFLICT DO NOTHING; items/mappings join on package code.

BEGIN;

INSERT INTO service_packages (code, name_th, name_en, description_th, description_en, sort_order) VALUES
  ('companion_care', 'ชุดเพื่อนคู่ใจและพาไปธุระ', 'Companion and errands',
   'เป็นเพื่อนคุย พาไปทำธุระหรือพาไปหาหมอ และช่วยเรื่องทั่วไปในชีวิตประจำวัน',
   'Companionship, errands and escorted appointments, with general daily help', 10),
  ('daily_care', 'ชุดดูแลกิจวัตรประจำวัน', 'Daily living care',
   'ช่วยกิจวัตรประจำวัน ดูแลเรื่องยาตามแพทย์สั่ง และเป็นเพื่อน',
   'Help with daily routines, medication as prescribed, and companionship', 20),
  ('rehab_care', 'ชุดฟื้นฟูร่างกาย', 'Rehabilitation care',
   'กายภาพบำบัดโดยนักกายภาพ ร่วมกับการดูแลทั่วไป',
   'Physiotherapy by a licensed physiotherapist, with general care', 30),
  ('bedridden_full', 'ชุดดูแลผู้ป่วยติดเตียง', 'Bedridden care',
   'ดูแลผู้ป่วยติดเตียงและดูแลเรื่องยาตามแพทย์สั่ง หากต้องการกายภาพให้เลือกชุดฟื้นฟูร่างกาย',
   'Care for bedridden patients and medication as prescribed; choose Rehabilitation care for physiotherapy', 40)
ON CONFLICT (code) DO NOTHING;

INSERT INTO service_package_items (package_id, service_type, sort_order)
SELECT p.id, v.service_type, v.sort_order
  FROM (VALUES
    ('companion_care', 'companion',      10),
    ('companion_care', 'general_care',   20),
    ('daily_care',     'general_care',   10),
    ('daily_care',     'medication',     20),
    ('daily_care',     'companion',      30),
    ('rehab_care',     'physiotherapy',  10),
    ('rehab_care',     'general_care',   20),
    ('bedridden_full', 'bedridden_care', 10),
    ('bedridden_full', 'medication',     20)
  ) AS v(code, service_type, sort_order)
  JOIN service_packages p ON p.code = v.code
ON CONFLICT (package_id, service_type) DO NOTHING;

INSERT INTO care_group_service_packages (care_group, package_id, sort_order)
SELECT v.care_group, p.id, v.sort_order
  FROM (VALUES
    ('social',    'companion_care', 10),
    ('social',    'daily_care',     20),
    ('homebound', 'daily_care',     10),
    ('homebound', 'rehab_care',     20),
    ('bedridden', 'bedridden_full', 10),
    ('bedridden', 'rehab_care',     20)
  ) AS v(care_group, code, sort_order)
  JOIN service_packages p ON p.code = v.code
ON CONFLICT (care_group, package_id) DO NOTHING;

COMMIT;

-- Post-run checks
-- SELECT count(*) FROM service_packages;                         -- 4
-- SELECT count(*) FROM service_package_items;                    -- 9
-- SELECT care_group, count(*) FROM care_group_service_packages
--  GROUP BY care_group ORDER BY care_group;                      -- bedridden 2, homebound 2, social 2
-- SELECT p.code, string_agg(i.service_type, ',' ORDER BY i.sort_order)
--   FROM service_packages p JOIN service_package_items i ON i.package_id = p.id
--  GROUP BY p.code ORDER BY p.code;
--   -- bedridden_full: bedridden_care,medication (no physiotherapy)
