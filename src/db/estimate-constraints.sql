-- Estimate intake checks. migrate.js runs this only after schema.sql has
-- committed, in its own transaction, with SET LOCAL lock_timeout 5s and
-- statement_timeout 15s. schema.sql adds the hostile checks NOT VALID.
-- VALIDATE scans existing rows. A failure raises a warning and does not
-- roll back schema.sql or this constraint. New rows are still checked.
-- The warning is the constraint name and SQLERRM. It does not include the
-- stored name, email, or id.
--
-- A customer delete must not remove opt-out emails. schema.sql creates
-- pilot_estimate_suppressions with no foreign key. A database that already
-- booted with ON DELETE CASCADE still has that key; drop it here so the
-- rows stay under the old customer id. This file does not UPDATE rows.

DO $$
BEGIN
  ALTER TABLE pilot_open_estimates VALIDATE CONSTRAINT pilot_open_estimates_name_hostile_check;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'pilot_estimates: name check validation failed: %', SQLERRM;
END $$;

DO $$
BEGIN
  ALTER TABLE pilot_open_estimates VALIDATE CONSTRAINT pilot_open_estimates_job_hostile_check;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'pilot_estimates: job check validation failed: %', SQLERRM;
END $$;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'pilot_estimate_suppressions_customer_id_fkey'
  ) THEN
    ALTER TABLE pilot_estimate_suppressions
      DROP CONSTRAINT pilot_estimate_suppressions_customer_id_fkey;
  END IF;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'pilot_estimates: suppression customer link not removed: %', SQLERRM;
END $$;
