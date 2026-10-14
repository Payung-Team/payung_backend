-- Caregiver skills → central codes (care_skills) + new other_skills column
-- Hand-written. Deploy only via `prisma migrate deploy` after Sammy approves.
-- Keeps the original values in skills_legacy so this can be reviewed or reversed.
-- Safe to re-run: always recomputes from skills_legacy, which is only filled once.

BEGIN;

-- 1) New columns
ALTER TABLE caregivers ADD COLUMN IF NOT EXISTS other_skills  text[] NOT NULL DEFAULT '{}';
ALTER TABLE caregivers ADD COLUMN IF NOT EXISTS skills_legacy text[];

UPDATE caregivers
   SET skills_legacy = skills
 WHERE skills_legacy IS NULL
   AND skills IS NOT NULL;

-- 2) Rebuild skills / other_skills from skills_legacy
WITH legacy_map(old_value, new_code, other_label) AS (VALUES
  ('bathing',              'bathing',             NULL),
  ('mobility',             'transfer_assist',     NULL),
  ('mobility',             'wheelchair_push',     NULL),
  ('การช่วยเหลือการเดิน',     'transfer_assist',     NULL),
  ('dementia_care',        'dementia_care',       NULL),
  ('wound_care',           'pressure_ulcer_care', NULL),
  ('physical_therapy',     NULL,                  'กายภาพบำบัด'),
  ('medication',           NULL,                  'ดูแลเรื่องยา'),
  ('การยา',                NULL,                  'ดูแลเรื่องยา'),
  ('cooking',              NULL,                  'ทำอาหาร'),
  ('การเตรียมอาหาร',         NULL,                  'ทำอาหาร'),
  ('companionship',        NULL,                  'เป็นเพื่อนคุย'),
  ('การดูแลด้านสุขภาพ',       NULL,                  'การดูแลด้านสุขภาพ'),
  ('การปรึกษา',             NULL,                  'การปรึกษา'),
  ('elder_care',           NULL,                  'ดูแลผู้สูงอายุ')
),
-- Skills that only a given profession may hold (same rule as the KYC page)
profession_only(skill_code, profession) AS (VALUES
  ('injection',            'nurse'),
  ('tube_feeding',         'nurse'),
  ('suction',              'nurse'),
  ('tracheostomy_care',    'nurse'),
  ('abdominal_wound_care', 'nurse'),
  ('physiotherapy',        'physiotherapist')
),
expanded AS (
  SELECT c.id, c.profession, btrim(v.val) AS val
    FROM caregivers c
    CROSS JOIN LATERAL unnest(c.skills_legacy) AS v(val)
   WHERE c.skills_legacy IS NOT NULL
     AND btrim(v.val) <> ''
),
-- value -> candidate central code (from the map, or already a central code) or a free-text label
candidates AS (
  SELECT e.id, e.profession, e.val,
         COALESCE(m.new_code, cs.code)                                         AS code,
         CASE WHEN m.old_value IS NULL AND cs.code IS NULL THEN e.val
              ELSE m.other_label END                                           AS label
    FROM expanded e
    LEFT JOIN legacy_map  m  ON m.old_value = e.val
    LEFT JOIN care_skills cs ON cs.code = e.val
),
-- a central code the caregiver's profession may not hold becomes free text (its Thai name)
resolved AS (
  SELECT c.id,
         CASE WHEN po.skill_code IS NOT NULL AND po.profession <> c.profession THEN NULL
              ELSE c.code END                                                  AS code,
         CASE WHEN po.skill_code IS NOT NULL AND po.profession <> c.profession THEN cs.name_th
              ELSE c.label END                                                 AS label
    FROM candidates c
    LEFT JOIN profession_only po ON po.skill_code = c.code
    LEFT JOIN care_skills     cs ON cs.code = c.code
),
agg AS (
  SELECT id,
         COALESCE(array_agg(DISTINCT code)  FILTER (WHERE code  IS NOT NULL), '{}') AS codes,
         COALESCE(array_agg(DISTINCT label) FILTER (WHERE label IS NOT NULL), '{}') AS labels
    FROM resolved
   GROUP BY id
)
UPDATE caregivers c
   SET skills       = a.codes,
       other_skills = a.labels
  FROM agg a
 WHERE a.id = c.id;

COMMIT;

-- Post-run checks
-- 1. every value left in skills is a central code (expect 0 rows)
-- SELECT DISTINCT s FROM caregivers, unnest(skills) s
--  WHERE s NOT IN (SELECT code FROM care_skills);
-- 2. no caregiver holds a skill locked to another profession (expect 0)
-- SELECT count(*) FROM caregivers
--  WHERE profession <> 'nurse' AND skills && ARRAY['injection','tube_feeding','suction','tracheostomy_care','abdominal_wound_care'];
-- 3. distribution
-- SELECT s, count(*) FROM caregivers, unnest(skills) s GROUP BY s ORDER BY 2 DESC;
-- SELECT s, count(*) FROM caregivers, unnest(other_skills) s GROUP BY s ORDER BY 2 DESC;
-- 4. caregivers with more than 5 free-text skills (UI limit is 5; report, do not trim)
-- SELECT count(*) FROM caregivers WHERE cardinality(other_skills) > 5;
