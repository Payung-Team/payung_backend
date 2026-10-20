-- Read-only S16 rollout check. Zero rows means all required seed rules are ready.
-- In particular F03 must have the 9 Oct correction before enabling S16.
WITH expected(source, code, variant, level) AS (
  VALUES
    ('flag','ng_tube','','advanced'),
    ('flag','urinary_catheter','','advanced'),
    ('flag','oxygen','','advanced'),
    ('flag','pressure_ulcer','','advanced'),
    ('flag','injection','','advanced'),
    ('flag','end_of_life','','advanced'),
    ('flag','dementia','severe','advanced'),
    ('flag','dementia','','intermediate'),
    ('flag','diabetes','','intermediate'),
    ('flag','fall_risk','','intermediate'),
    ('flag','unsure','','intermediate'),
    ('service','F03','','advanced')
)
SELECT e.source, e.code, e.variant, e.level AS expected_level,
       r.level AS actual_level, r.is_active
FROM expected e
LEFT JOIN booking_level_rules r USING (source, code, variant)
WHERE r.code IS NULL OR NOT r.is_active OR r.level IS DISTINCT FROM e.level
ORDER BY e.source, e.code, e.variant;
