-- PYG-614: run once by the DB owner BEFORE enabling non-null assessment output.
-- Not a migration and not invoked on app startup. Do not change assessed_at:
-- this restores derived data, it is not a new assessment or user consent.
BEGIN;
LOCK TABLE care_recipient_assessments IN SHARE ROW EXCLUSIVE MODE;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM care_recipient_assessments
    WHERE adl_total_score IS NULL OR adl_total_score NOT BETWEEN 0 AND 20
  ) THEN
    RAISE EXCEPTION 'Invalid assessment scores; stop S09 rollout';
  END IF;
END $$;

-- Same boundaries as PYG-613 and common/care-group.ts (tested for all 21 scores).
UPDATE care_recipient_assessments
SET care_group = CASE
  WHEN adl_total_score >= 12 THEN 'social'
  WHEN adl_total_score >= 5 THEN 'homebound'
  ELSE 'bedridden'
END
WHERE care_group IS DISTINCT FROM CASE
  WHEN adl_total_score >= 12 THEN 'social'
  WHEN adl_total_score >= 5 THEN 'homebound'
  ELSE 'bedridden'
END;
COMMIT;
