-- PYG-642: seed care_skills (15) and care_skill_rules (18) from the Required Skills infographic (Phase ทดลอง)
-- Hand-written. Deploy only via `prisma migrate deploy` after Sammy approves.
-- Safe to re-run: ON CONFLICT DO NOTHING.
-- ADL source_code must match the keys S08 writes into care_recipient_assessments.adl_answers (Barthel item names).
-- Flag source_code matches booking_level_rules (source = 'flag'). Service source_code = care_activities.code.

BEGIN;

INSERT INTO care_skills (code, name_th, name_en) VALUES
  ('transfer_assist',      'ย้ายตัว / พยุงตัว',              'Transfer assistance'),
  ('wheelchair_push',      'เข็นรถเข็น',                     'Wheelchair pushing'),
  ('feeding_assist',       'ป้อนอาหาร',                      'Feeding assistance'),
  ('toileting_care',       'เปลี่ยนผ้าอ้อม / ดูแลการขับถ่าย',    'Toileting and continence care'),
  ('bathing',              'อาบน้ำ / เช็ดตัว',                'Bathing'),
  ('dressing_assist',      'ช่วยแต่งตัว',                     'Dressing assistance'),
  ('pressure_ulcer_care',  'ทำแผล / พลิกตัว',                 'Pressure ulcer care and repositioning'),
  ('tube_feeding',         'ให้อาหารทางสายยาง',               'Tube feeding'),
  ('dementia_care',        'ดูแลผู้ป่วยสมองเสื่อม',             'Dementia care'),
  ('glucose_diet_care',    'วัดน้ำตาล / คุมอาหาร',             'Blood glucose and diet care'),
  ('injection',            'ฉีดยา',                         'Injection'),
  ('physiotherapy',        'กายภาพบำบัด',                    'Physiotherapy'),
  ('suction',              'ดูดเสมหะ',                       'Suctioning'),
  ('tracheostomy_care',    'ดูแลท่อเจาะคอ',                   'Tracheostomy care'),
  ('abdominal_wound_care', 'ทำแผลหน้าท้อง',                   'Abdominal wound care')
ON CONFLICT (code) DO NOTHING;

INSERT INTO care_skill_rules (source, source_code, score_min, score_max, skill_code) VALUES
  -- ADL (7)
  ('adl', 'transfers', 0, 1, 'transfer_assist'),
  ('adl', 'mobility',  0, 1, 'wheelchair_push'),
  ('adl', 'feeding',   0, 1, 'feeding_assist'),
  ('adl', 'bladder',   0, 0, 'toileting_care'),
  ('adl', 'bowels',    0, 0, 'toileting_care'),
  ('adl', 'bathing',   0, 0, 'bathing'),
  ('adl', 'dressing',  0, 1, 'dressing_assist'),
  -- Flag (5)
  ('flag', 'pressure_ulcer', NULL, NULL, 'pressure_ulcer_care'),
  ('flag', 'ng_tube',        NULL, NULL, 'tube_feeding'),
  ('flag', 'dementia',       NULL, NULL, 'dementia_care'),
  ('flag', 'diabetes',       NULL, NULL, 'glucose_diet_care'),
  ('flag', 'injection',      NULL, NULL, 'injection'),
  -- Service (6)
  ('service', 'F03', NULL, NULL, 'physiotherapy'),
  ('service', 'C04', NULL, NULL, 'tube_feeding'),
  ('service', 'D05', NULL, NULL, 'injection'),
  ('service', 'E04', NULL, NULL, 'suction'),
  ('service', 'E05', NULL, NULL, 'tracheostomy_care'),
  ('service', 'E07', NULL, NULL, 'abdominal_wound_care')
ON CONFLICT (source, source_code, skill_code) DO NOTHING;

COMMIT;

-- Post-run checks (expected: adl 7, flag 5, service 6; orphan 0; bookings with skills 0)
-- SELECT source, count(*) FROM care_skill_rules GROUP BY source ORDER BY source;
-- SELECT count(*) FROM care_skills;  -- 15
-- SELECT count(*) FROM care_skill_rules r LEFT JOIN care_skills s ON s.code = r.skill_code WHERE s.code IS NULL;
-- SELECT count(*) FROM care_skill_rules r WHERE r.source = 'service'
--   AND NOT EXISTS (SELECT 1 FROM care_activities a WHERE a.code = r.source_code);  -- 0
-- SELECT count(*) FROM care_skill_rules r WHERE r.source = 'flag'
--   AND NOT EXISTS (SELECT 1 FROM booking_level_rules b WHERE b.source = 'flag' AND b.code = r.source_code);  -- 0
