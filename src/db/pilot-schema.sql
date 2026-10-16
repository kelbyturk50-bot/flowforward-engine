-- Pilot data repair. migrate.js runs this only after schema.sql has committed,
-- in its own transaction, with SET LOCAL lock_timeout and statement_timeout.
-- A failure here rolls back only this transaction. The tables and columns
-- created in schema.sql stay.
--
-- A lock or statement timeout is re-raised so the first wait aborts this
-- transaction. Other errors are stored through pilot_boot_failure (step,
-- SQLSTATE, truncated sanitized message) and do not abort the file.
-- Generation 0 is only the legacy backfill. derived stays false for those rows.

DELETE FROM pilot_boot_errors;

-- Fill generation and revoke legacy rows together. A trigger that blocks
-- only revoked_at rejects this whole statement, so generation stays null
-- instead of becoming a live 0. The next boot retries the same statement.
DO $$
DECLARE
  err text;
  state text;
BEGIN
  UPDATE pilot_tokens
     SET generation = COALESCE(generation, 0),
         derived = FALSE,
         revoked_at = COALESCE(revoked_at, NOW())
   WHERE generation IS NULL
      OR (derived IS NOT TRUE AND revoked_at IS NULL);
EXCEPTION WHEN OTHERS THEN
  IF SQLSTATE IN ('55P03', '57014') THEN
    RAISE;
  END IF;
  GET STACKED DIAGNOSTICS err = MESSAGE_TEXT, state = RETURNED_SQLSTATE;
  PERFORM pilot_boot_failure('revoke-legacy', state, err);
  RAISE WARNING 'pilot_tokens: revoke legacy rows failed: %', state;
END $$;

DO $$
DECLARE
  err text;
  state text;
BEGIN
  UPDATE pilot_tokens t
     SET revoked_at = NOW()
   WHERE t.revoked_at IS NULL
     AND EXISTS (
       SELECT 1 FROM pilot_tokens n
        WHERE n.proposal_id = t.proposal_id
          AND n.revoked_at IS NULL
          AND n.id > t.id
     );
EXCEPTION WHEN OTHERS THEN
  IF SQLSTATE IN ('55P03', '57014') THEN
    RAISE;
  END IF;
  GET STACKED DIAGNOSTICS err = MESSAGE_TEXT, state = RETURNED_SQLSTATE;
  PERFORM pilot_boot_failure('revoke-duplicate-active', state, err);
  RAISE WARNING 'pilot_tokens: revoke duplicate active rows failed: %', state;
END $$;

DO $$
DECLARE
  err text;
  state text;
BEGIN
  ALTER TABLE pilot_tokens ALTER COLUMN generation SET NOT NULL;
EXCEPTION WHEN OTHERS THEN
  IF SQLSTATE IN ('55P03', '57014') THEN
    RAISE;
  END IF;
  GET STACKED DIAGNOSTICS err = MESSAGE_TEXT, state = RETURNED_SQLSTATE;
  PERFORM pilot_boot_failure('generation-not-null', state, err);
  RAISE WARNING 'pilot_tokens: generation NOT NULL failed: %', state;
END $$;

DO $$
DECLARE
  err text;
  state text;
BEGIN
  CREATE UNIQUE INDEX IF NOT EXISTS idx_pilot_tokens_one_active
    ON pilot_tokens (proposal_id)
    WHERE revoked_at IS NULL;
EXCEPTION WHEN OTHERS THEN
  IF SQLSTATE IN ('55P03', '57014') THEN
    RAISE;
  END IF;
  GET STACKED DIAGNOSTICS err = MESSAGE_TEXT, state = RETURNED_SQLSTATE;
  PERFORM pilot_boot_failure('unique-active-index', state, err);
  RAISE WARNING 'pilot_tokens: unique active index failed: %', state;
END $$;
