-- Read-only readiness gate. No health values or recipient IDs in the result.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM care_recipient_assessments
    WHERE care_group IS NULL
       OR adl_total_score IS NULL
       OR adl_total_score NOT BETWEEN 0 AND 20
       OR care_group IS DISTINCT FROM CASE
            WHEN adl_total_score >= 12 THEN 'social'
            WHEN adl_total_score >= 5 THEN 'homebound'
            ELSE 'bedridden'
          END
  ) THEN
    RAISE EXCEPTION 'S09 not ready: assessment groups must be backfilled before rollout';
  END IF;
END $$;
