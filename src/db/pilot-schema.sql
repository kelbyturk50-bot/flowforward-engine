-- ═══════════════════════════════════════════════════════════════════════════
-- Pilot #1: unsold-estimate recovery demo (idempotent — applied on boot)
-- Public lookup uses the SHA-256 hash. The raw token is not a column.
-- DROP COLUMN removes it on databases that stored one. generation is the
-- HMAC input; /p/:slug recomputes the token and does not insert a row.
-- One active (unrevoked) row per proposal. Authenticated mint bumps
-- generation. demo_revoked_at blocks derivation, discarded proposals included.
-- Events store an allowlisted type, timestamps, and join ids only.
--
-- Upgrades from the pre-generation table can have several active rows and a
-- nullable generation. derived is true only for rows inserted by the HMAC
-- mint. Existing rows are derived false. Any row with a null generation, or
-- any still-active row that is not derived, is revoked in the same statement
-- that fills generation, so a failed revoke cannot leave a live generation-0
-- hash. Generation 0 is only that backfill. Duplicate derived rows then keep
-- the newest id. generation is set NOT NULL and the unique partial index is
-- created. Each repair step is its own DO block. A caught error does not
-- abort this file. The handler writes the error into pilot_boot_errors so
-- boot can read it after commit. Boot also requires zero active rows that
-- are underived or have a null generation. After the first successful boot
-- the updates match zero rows and pilot_boot_errors is empty.
--
-- This file is not part of schema.sql. migrate.js runs it only after that
-- file has committed, inside its own transaction, with SET LOCAL
-- lock_timeout and statement_timeout. A failure or timeout here rolls back
-- only this transaction. It does not roll back schema.sql.
-- ═══════════════════════════════════════════════════════════════════════════

ALTER TABLE proposals ADD COLUMN IF NOT EXISTS demo_revoked_at TIMESTAMPTZ;

CREATE TABLE IF NOT EXISTS pilot_tokens (
  id           SERIAL PRIMARY KEY,
  proposal_id  INTEGER NOT NULL REFERENCES proposals(id) ON DELETE CASCADE,
  prospect_id  INTEGER NOT NULL REFERENCES prospects(id) ON DELETE CASCADE,
  generation   INTEGER NOT NULL,
  derived      BOOLEAN NOT NULL DEFAULT FALSE,
  token_hash   BYTEA NOT NULL UNIQUE,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at   TIMESTAMPTZ NOT NULL,
  revoked_at   TIMESTAMPTZ
);
ALTER TABLE pilot_tokens ADD COLUMN IF NOT EXISTS generation INTEGER;
ALTER TABLE pilot_tokens ADD COLUMN IF NOT EXISTS derived BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE pilot_tokens DROP COLUMN IF EXISTS token;

-- Repair failures from this boot only. Cleared at the start of every boot.
CREATE TABLE IF NOT EXISTS pilot_boot_errors (
  id         SERIAL PRIMARY KEY,
  step       TEXT NOT NULL,
  message    TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
DELETE FROM pilot_boot_errors;

-- Fill generation and revoke legacy rows together. A trigger that blocks
-- only revoked_at rejects this whole statement, so generation stays null
-- instead of becoming a live 0. The next boot retries the same statement.
DO $$
DECLARE
  err text;
BEGIN
  UPDATE pilot_tokens
     SET generation = COALESCE(generation, 0),
         derived = FALSE,
         revoked_at = COALESCE(revoked_at, NOW())
   WHERE generation IS NULL
      OR (derived IS NOT TRUE AND revoked_at IS NULL);
EXCEPTION WHEN OTHERS THEN
  err := SQLERRM;
  BEGIN
    INSERT INTO pilot_boot_errors (step, message)
    VALUES ('revoke-legacy', err);
  EXCEPTION WHEN OTHERS THEN
    NULL;
  END;
  RAISE WARNING 'pilot_tokens: revoke legacy rows failed: %', err;
END $$;

DO $$
DECLARE
  err text;
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
  err := SQLERRM;
  BEGIN
    INSERT INTO pilot_boot_errors (step, message)
    VALUES ('revoke-duplicate-active', err);
  EXCEPTION WHEN OTHERS THEN
    NULL;
  END;
  RAISE WARNING 'pilot_tokens: revoke duplicate active rows failed: %', err;
END $$;

DO $$
DECLARE
  err text;
BEGIN
  ALTER TABLE pilot_tokens ALTER COLUMN generation SET NOT NULL;
EXCEPTION WHEN OTHERS THEN
  err := SQLERRM;
  BEGIN
    INSERT INTO pilot_boot_errors (step, message)
    VALUES ('generation-not-null', err);
  EXCEPTION WHEN OTHERS THEN
    NULL;
  END;
  RAISE WARNING 'pilot_tokens: generation NOT NULL failed: %', err;
END $$;

CREATE INDEX IF NOT EXISTS idx_pilot_tokens_proposal ON pilot_tokens(proposal_id);

DO $$
DECLARE
  err text;
BEGIN
  CREATE UNIQUE INDEX IF NOT EXISTS idx_pilot_tokens_one_active
    ON pilot_tokens (proposal_id)
    WHERE revoked_at IS NULL;
EXCEPTION WHEN OTHERS THEN
  err := SQLERRM;
  BEGIN
    INSERT INTO pilot_boot_errors (step, message)
    VALUES ('unique-active-index', err);
  EXCEPTION WHEN OTHERS THEN
    NULL;
  END;
  RAISE WARNING 'pilot_tokens: unique active index failed: %', err;
END $$;

CREATE TABLE IF NOT EXISTS pilot_events (
  id           SERIAL PRIMARY KEY,
  event_type   TEXT NOT NULL,
  token_id     INTEGER REFERENCES pilot_tokens(id) ON DELETE CASCADE,
  proposal_id  INTEGER REFERENCES proposals(id) ON DELETE CASCADE,
  prospect_id  INTEGER REFERENCES prospects(id) ON DELETE CASCADE,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_pilot_events_proposal ON pilot_events(proposal_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_pilot_events_token ON pilot_events(token_id);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'pilot_events_type_check'
  ) THEN
    ALTER TABLE pilot_events ADD CONSTRAINT pilot_events_type_check
      CHECK (event_type IN (
        'demo_view',
        'step_estimates',
        'step_preview',
        'step_reply',
        'step_recovered',
        'estimate_recovered'
      ));
  END IF;
END $$;
