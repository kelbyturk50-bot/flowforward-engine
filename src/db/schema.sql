-- FlowForward Engine — PostgreSQL Schema
-- Run once on a fresh database: node src/db/migrate.js

CREATE TABLE IF NOT EXISTS prospects (
  id              SERIAL PRIMARY KEY,
  google_place_id TEXT UNIQUE,                    -- deduplication key
  company         TEXT NOT NULL,
  industry        TEXT NOT NULL,
  phone           TEXT,
  website         TEXT,
  address         TEXT,
  city            TEXT,
  state           TEXT,
  zip             TEXT,
  rating          NUMERIC(2,1),
  review_count    INTEGER,
  stage           TEXT NOT NULL DEFAULT 'found',  -- found|contacted|responded|vetted|brief
  score           INTEGER DEFAULT 5,              -- 1–10 fit score
  note            TEXT,
  brief           TEXT,                           -- AI-generated project brief
  outreach_draft  TEXT,                           -- AI-generated email draft
  source          TEXT DEFAULT 'google_places',
  discovered_at   TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW()
);

-- Index for fast stage queries
CREATE INDEX IF NOT EXISTS idx_prospects_stage ON prospects(stage);
CREATE INDEX IF NOT EXISTS idx_prospects_industry ON prospects(industry);
CREATE INDEX IF NOT EXISTS idx_prospects_discovered ON prospects(discovered_at DESC);

-- Auto-update updated_at on any row change
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS prospects_updated_at ON prospects;
CREATE TRIGGER prospects_updated_at
  BEFORE UPDATE ON prospects
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- Discovery run log
CREATE TABLE IF NOT EXISTS discovery_runs (
  id           SERIAL PRIMARY KEY,
  started_at   TIMESTAMPTZ DEFAULT NOW(),
  finished_at  TIMESTAMPTZ,
  queries_run  INTEGER DEFAULT 0,
  found        INTEGER DEFAULT 0,   -- total results from API
  new_added    INTEGER DEFAULT 0,   -- net new (not dupes)
  errors       INTEGER DEFAULT 0,
  status       TEXT DEFAULT 'running'  -- running|done|failed
);

-- ═══════════════════════════════════════════════════════════════════════════
-- CRM buildout (idempotent — safe to re-run; applied automatically on boot)
-- ═══════════════════════════════════════════════════════════════════════════

-- Lead fields for fit ranking, contact info and follow-ups
ALTER TABLE prospects ADD COLUMN IF NOT EXISTS fit_score         INTEGER;      -- 0–100, computed
ALTER TABLE prospects ADD COLUMN IF NOT EXISTS fit_tier          TEXT;         -- A|B|C|D, computed
ALTER TABLE prospects ADD COLUMN IF NOT EXISTS fit_reasons       JSONB;        -- [{label, points, max, detail}]
ALTER TABLE prospects ADD COLUMN IF NOT EXISTS fit_boost         INTEGER DEFAULT 0; -- manual -20..+20
ALTER TABLE prospects ADD COLUMN IF NOT EXISTS contact_name      TEXT;
ALTER TABLE prospects ADD COLUMN IF NOT EXISTS email             TEXT;
ALTER TABLE prospects ADD COLUMN IF NOT EXISTS next_action       TEXT;
ALTER TABLE prospects ADD COLUMN IF NOT EXISTS next_action_at    DATE;
ALTER TABLE prospects ADD COLUMN IF NOT EXISTS last_contacted_at TIMESTAMPTZ;
ALTER TABLE prospects ADD COLUMN IF NOT EXISTS est_value         NUMERIC(12,2);

-- Stage model: found → contacted → responded → qualified → proposal → won | lost | disqualified
UPDATE prospects SET stage = 'qualified' WHERE stage = 'vetted';
UPDATE prospects SET stage = 'proposal'  WHERE stage = 'brief';

CREATE INDEX IF NOT EXISTS idx_prospects_fit         ON prospects(fit_score DESC);
CREATE INDEX IF NOT EXISTS idx_prospects_next_action ON prospects(next_action_at);
CREATE INDEX IF NOT EXISTS idx_prospects_city        ON prospects(city);

-- Activity log per lead (calls, emails, meetings, notes, stage changes)
CREATE TABLE IF NOT EXISTS prospect_activities (
  id           SERIAL PRIMARY KEY,
  prospect_id  INTEGER NOT NULL REFERENCES prospects(id) ON DELETE CASCADE,
  type         TEXT NOT NULL DEFAULT 'note',   -- note|call|email|meeting|stage_change
  body         TEXT,
  created_at   TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_activities_prospect ON prospect_activities(prospect_id, created_at DESC);

-- Work projects — linked to a client (prospect) or standalone
CREATE TABLE IF NOT EXISTS projects (
  id           SERIAL PRIMARY KEY,
  name         TEXT NOT NULL,
  prospect_id  INTEGER REFERENCES prospects(id) ON DELETE SET NULL,
  status       TEXT NOT NULL DEFAULT 'planning', -- planning|active|on_hold|done|cancelled
  priority     TEXT NOT NULL DEFAULT 'medium',   -- low|medium|high
  value        NUMERIC(12,2),
  start_date   DATE,
  due_date     DATE,
  description  TEXT,
  created_at   TIMESTAMPTZ DEFAULT NOW(),
  updated_at   TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_projects_status ON projects(status);

DROP TRIGGER IF EXISTS projects_updated_at ON projects;
CREATE TRIGGER projects_updated_at
  BEFORE UPDATE ON projects
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE TABLE IF NOT EXISTS tasks (
  id           SERIAL PRIMARY KEY,
  project_id   INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  title        TEXT NOT NULL,
  done         BOOLEAN NOT NULL DEFAULT FALSE,
  due_date     DATE,
  sort_order   INTEGER DEFAULT 0,
  created_at   TIMESTAMPTZ DEFAULT NOW(),
  completed_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_tasks_project ON tasks(project_id);

-- ═══════════════════════════════════════════════════════════════════════════
-- Proposal bot (idempotent — applied automatically on boot)
-- ═══════════════════════════════════════════════════════════════════════════

ALTER TABLE prospects ADD COLUMN IF NOT EXISTS do_not_contact BOOLEAN NOT NULL DEFAULT FALSE; -- opted out / bounced
-- Source written only when the flag is raised: manual or opt_out, or NULL.
-- A flagged row whose source is still NULL is automatic and cannot be cleared.
-- This file does not backfill. The v2 check replaces the earlier name so a
-- database that booted that definition ends on manual, opt_out, or NULL.
ALTER TABLE prospects ADD COLUMN IF NOT EXISTS do_not_contact_source TEXT;
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM pg_constraint c
      JOIN pg_class t ON t.oid = c.conrelid
      JOIN pg_namespace n ON n.oid = t.relnamespace
     WHERE c.conname = 'prospects_do_not_contact_source_check'
       AND t.relname = 'prospects'
       AND n.nspname = 'public'
  ) THEN
    ALTER TABLE prospects DROP CONSTRAINT prospects_do_not_contact_source_check;
  END IF;

  IF NOT EXISTS (
    SELECT 1
      FROM pg_constraint c
      JOIN pg_class t ON t.oid = c.conrelid
      JOIN pg_namespace n ON n.oid = t.relnamespace
     WHERE c.conname = 'prospects_dnc_source_v2_chk'
       AND t.relname = 'prospects'
       AND n.nspname = 'public'
  ) THEN
    ALTER TABLE prospects
      ADD CONSTRAINT prospects_dnc_source_v2_chk
      CHECK (
        do_not_contact_source IS NULL
        OR do_not_contact_source IN ('manual', 'opt_out')
      );
  END IF;
END $$;
ALTER TABLE prospects ADD COLUMN IF NOT EXISTS researched_at  TIMESTAMPTZ;
-- Archive flag. NULL archived_at means the lead is still in the working set.
-- archive_run_id is the apply that set the flag. Undo restores that run only.
-- Boot adds the columns and does not set them. The row update is an explicit
-- script, not a statement in this file.
ALTER TABLE prospects ADD COLUMN IF NOT EXISTS archived_at    TIMESTAMPTZ;
ALTER TABLE prospects ADD COLUMN IF NOT EXISTS archive_reason TEXT;
ALTER TABLE prospects ADD COLUMN IF NOT EXISTS archive_run_id TEXT;
CREATE INDEX IF NOT EXISTS idx_prospects_archived ON prospects(archived_at) WHERE archived_at IS NOT NULL;
-- Field-service software cached by proposal research. NULL = unknown, so fit
-- scoring applies no ServiceTitan penalty or tier cap. Only the value
-- ServiceTitan is penalized (−15) and capped at tier B. computeFit / rescore
-- read this column and do not fetch.
ALTER TABLE prospects ADD COLUMN IF NOT EXISTS fsm_detected TEXT;

-- One row per generated version. Regenerating creates a new version and marks
-- the previous draft 'superseded'. Human edits land on the same row; the AI's
-- untouched output is kept in ai_original so edits can be compared later.
CREATE TABLE IF NOT EXISTS proposals (
  id                SERIAL PRIMARY KEY,
  prospect_id       INTEGER NOT NULL REFERENCES prospects(id) ON DELETE CASCADE,
  version           INTEGER NOT NULL DEFAULT 1,
  status            TEXT NOT NULL DEFAULT 'draft',
    -- draft | sent (sequence running) | replied | bounced | opted_out | finished | stopped | discarded | superseded
  slug              TEXT UNIQUE NOT NULL,          -- public one-pager URL: /p/<slug>
  to_email          TEXT,
  to_name           TEXT,
  subject           TEXT,
  body              TEXT,                          -- first email
  followup1         TEXT,                          -- day-3 nudge (sent as reply in thread)
  followup2         TEXT,                          -- day-10 nudge
  onepager          JSONB,                         -- {headline, intro, observations[], opportunities[], next_steps}
  analysis          JSONB,                         -- {snapshot, pain_signals[], fit_verdict, fit_reason, owner_name, confidence...}
  research          JSONB,                         -- raw signals gathered (site, reviews, socials, emails)
  ai_original       JSONB,                         -- untouched AI copy for this version
  instructions      TEXT,                          -- extra guidance given when regenerating
  model             TEXT,
  input_tokens      INTEGER DEFAULT 0,
  output_tokens     INTEGER DEFAULT 0,
  searches          INTEGER DEFAULT 0,
  cost_usd          NUMERIC(10,4) DEFAULT 0,
  feedback_rating   SMALLINT,                      -- 1 = good, -1 = bad
  feedback_note     TEXT,
  approved_at       TIMESTAMPTZ,
  sent_at           TIMESTAMPTZ,
  message_id        TEXT,                          -- Message-ID of the first email (threading)
  followup1_due_at  TIMESTAMPTZ,
  followup1_sent_at TIMESTAMPTZ,
  followup2_due_at  TIMESTAMPTZ,
  followup2_sent_at TIMESTAMPTZ,
  replied_at        TIMESTAMPTZ,
  stop_reason       TEXT,
  views             INTEGER NOT NULL DEFAULT 0,    -- one-pager opens
  last_viewed_at    TIMESTAMPTZ,
  error             TEXT,
  created_at        TIMESTAMPTZ DEFAULT NOW(),
  updated_at        TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_proposals_prospect ON proposals(prospect_id, version DESC);
CREATE INDEX IF NOT EXISTS idx_proposals_status   ON proposals(status);

DROP TRIGGER IF EXISTS proposals_updated_at ON proposals;
CREATE TRIGGER proposals_updated_at
  BEFORE UPDATE ON proposals
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- Nightly / manual drafting runs
CREATE TABLE IF NOT EXISTS proposal_runs (
  id           SERIAL PRIMARY KEY,
  trigger      TEXT NOT NULL DEFAULT 'nightly',   -- nightly | manual
  started_at   TIMESTAMPTZ DEFAULT NOW(),
  finished_at  TIMESTAMPTZ,
  status       TEXT NOT NULL DEFAULT 'running',   -- running | done | done_with_errors | failed
  requested    INTEGER DEFAULT 0,
  drafted      INTEGER DEFAULT 0,
  errors       INTEGER DEFAULT 0,
  cost_usd     NUMERIC(10,4) DEFAULT 0,
  log          JSONB DEFAULT '[]'::jsonb
);

-- Small key/value store for settings editable from the CRM (e.g. proposal voice notes)
CREATE TABLE IF NOT EXISTS app_settings (
  key         TEXT PRIMARY KEY,
  value       JSONB,
  updated_at  TIMESTAMPTZ DEFAULT NOW()
);

-- Gmail API sending: thread id of the first email so follow-ups land in the same thread
ALTER TABLE proposals ADD COLUMN IF NOT EXISTS thread_id TEXT;

-- Background drafting jobs (single-lead drafts and rewrites) so the CRM doesn't
-- have to wait on a long request. reviewed_at marks a draft as opened in the CRM.
CREATE TABLE IF NOT EXISTS proposal_jobs (
  id                  SERIAL PRIMARY KEY,
  prospect_id         INTEGER NOT NULL REFERENCES prospects(id) ON DELETE CASCADE,
  kind                TEXT NOT NULL DEFAULT 'rewrite',     -- draft | rewrite
  source_proposal_id  INTEGER REFERENCES proposals(id) ON DELETE SET NULL,
  instructions        TEXT,
  fresh_research      BOOLEAN NOT NULL DEFAULT FALSE,
  status              TEXT NOT NULL DEFAULT 'queued',      -- queued | running | done | failed
  result_proposal_id  INTEGER REFERENCES proposals(id) ON DELETE SET NULL,
  error               TEXT,
  created_at          TIMESTAMPTZ DEFAULT NOW(),
  started_at          TIMESTAMPTZ,
  finished_at         TIMESTAMPTZ,
  dismissed_at        TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_proposal_jobs_status ON proposal_jobs(status, created_at);
ALTER TABLE proposals ADD COLUMN IF NOT EXISTS reviewed_at TIMESTAMPTZ;
-- Drafts that existed before this column are treated as already seen
UPDATE proposals SET reviewed_at = created_at WHERE reviewed_at IS NULL AND created_at < '2026-10-15';

-- ═══════════════════════════════════════════════════════════════════════════
-- Pilot tables. Additive and idempotent, same transaction as the rest of
-- this file. This file does not set a session timeout; applyMainSchema sets
-- the transaction bounds before running it. A catalog check runs first so a
-- boot does not lock pilot_tokens when the table, column, or index is already
-- there. Data repairs and the unique active index live in pilot-schema.sql.
-- ═══════════════════════════════════════════════════════════════════════════

ALTER TABLE proposals ADD COLUMN IF NOT EXISTS demo_revoked_at TIMESTAMPTZ;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relname = 'pilot_tokens'
  ) THEN
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
  END IF;

  IF EXISTS (
    SELECT 1 FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relname = 'pilot_tokens'
  ) AND NOT EXISTS (
    SELECT 1 FROM pg_attribute a
      JOIN pg_class c ON c.oid = a.attrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relname = 'pilot_tokens'
       AND a.attname = 'generation' AND a.attnum > 0 AND NOT a.attisdropped
  ) THEN
    ALTER TABLE pilot_tokens ADD COLUMN IF NOT EXISTS generation INTEGER;
  END IF;

  IF EXISTS (
    SELECT 1 FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relname = 'pilot_tokens'
  ) AND NOT EXISTS (
    SELECT 1 FROM pg_attribute a
      JOIN pg_class c ON c.oid = a.attrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relname = 'pilot_tokens'
       AND a.attname = 'derived' AND a.attnum > 0 AND NOT a.attisdropped
  ) THEN
    ALTER TABLE pilot_tokens ADD COLUMN IF NOT EXISTS derived BOOLEAN NOT NULL DEFAULT FALSE;
  END IF;

  IF EXISTS (
    SELECT 1 FROM pg_attribute a
      JOIN pg_class c ON c.oid = a.attrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relname = 'pilot_tokens'
       AND a.attname = 'token' AND a.attnum > 0 AND NOT a.attisdropped
  ) THEN
    ALTER TABLE pilot_tokens DROP COLUMN IF EXISTS token;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relname = 'idx_pilot_tokens_proposal'
  ) THEN
    CREATE INDEX IF NOT EXISTS idx_pilot_tokens_proposal ON pilot_tokens(proposal_id);
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS pilot_boot_errors (
  id         SERIAL PRIMARY KEY,
  step       TEXT NOT NULL,
  message    TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Step name stays in its own column. The message is SQLSTATE plus a short
-- sanitized text: control characters removed, long token-like runs redacted,
-- then truncated. The raw database error is not stored.
CREATE OR REPLACE FUNCTION pilot_boot_failure(step text, state text, message text)
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
  clean text;
BEGIN
  clean := regexp_replace(COALESCE(message, ''), '[[:cntrl:]]+', ' ', 'g');
  clean := regexp_replace(clean, '[A-Za-z0-9_-]{32,}', '[redacted]', 'g');
  clean := left(btrim(clean), 200);
  INSERT INTO pilot_boot_errors (step, message)
  VALUES (left(COALESCE(step, 'pilot'), 80), left(COALESCE(state, 'XX000') || ': ' || clean, 240));
END;
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relname = 'pilot_events'
  ) THEN
    CREATE TABLE IF NOT EXISTS pilot_events (
      id           SERIAL PRIMARY KEY,
      event_type   TEXT NOT NULL,
      token_id     INTEGER REFERENCES pilot_tokens(id) ON DELETE CASCADE,
      proposal_id  INTEGER REFERENCES proposals(id) ON DELETE CASCADE,
      prospect_id  INTEGER REFERENCES prospects(id) ON DELETE CASCADE,
      created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relname = 'idx_pilot_events_proposal'
  ) THEN
    CREATE INDEX IF NOT EXISTS idx_pilot_events_proposal ON pilot_events(proposal_id, created_at DESC);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relname = 'idx_pilot_events_token'
  ) THEN
    CREATE INDEX IF NOT EXISTS idx_pilot_events_token ON pilot_events(token_id);
  END IF;

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

-- ═══════════════════════════════════════════════════════════════════════════
-- Brand entry and prototype rubric (idempotent — applied on every boot).
-- v1 stores manual brands only. Boot does not insert TEST: brand rows.
-- Fixtures live in src/brand/fixtures.js and are inserted by tests.
-- Nothing here fetches a logo or copies proposals.research.
-- prospects.research stays NULL until a caller writes a cache.
-- The picker reads it and does not fetch.
-- Rubric inserts use ON CONFLICT DO NOTHING so a re-boot does not rewrite rows.
-- ═══════════════════════════════════════════════════════════════════════════

ALTER TABLE prospects ADD COLUMN IF NOT EXISTS research JSONB;

CREATE TABLE IF NOT EXISTS prospect_brands (
  id           SERIAL PRIMARY KEY,
  prospect_id  INTEGER REFERENCES prospects(id) ON DELETE CASCADE,
  name         TEXT NOT NULL,
  logo_url     TEXT,
  colors       JSONB NOT NULL DEFAULT '[]'::jsonb,
  source       TEXT NOT NULL,
  test_tag     TEXT NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT prospect_brands_name_test CHECK (
    char_length(name) BETWEEN 6 AND 120
    AND left(name, 5) = 'TEST:'
    AND position('@' IN name) = 0
    AND name !~ U&'[[:cntrl:]<>\200B-\200F\202A-\202E\2060-\2064\2066-\2069\FEFF]'
    AND btrim(substring(name from 6)) ~ '[[:graph:]]'
  ),
  CONSTRAINT prospect_brands_source_check CHECK (source IN ('fixture', 'manual')),
  CONSTRAINT prospect_brands_tag_check CHECK (
    test_tag ~ '^TEST:[a-z0-9]+(-[a-z0-9]+)*$'
    AND char_length(test_tag) <= 80
  ),
  CONSTRAINT prospect_brands_logo_https CHECK (
    logo_url IS NULL OR (
      char_length(logo_url) BETWEEN 8 AND 300
      AND logo_url ~ '^https://'
      AND logo_url !~ '://[^/?#]*@'
      AND logo_url !~ '[[:space:][:cntrl:]]'
      AND logo_url !~ '[''"`();\\<>{}]'
    )
  ),
  CONSTRAINT prospect_brands_colors_hex CHECK (
    jsonb_typeof(colors) = 'array'
    AND jsonb_array_length(colors) BETWEEN 0 AND 8
    AND colors::text ~ '^\[(\s*"#[0-9a-f]{6}"(\s*,\s*"#[0-9a-f]{6}")*\s*)?\]$'
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_prospect_brands_test_tag ON prospect_brands (test_tag);
CREATE INDEX IF NOT EXISTS idx_prospect_brands_prospect ON prospect_brands (prospect_id);

DROP TRIGGER IF EXISTS prospect_brands_updated_at ON prospect_brands;
CREATE TRIGGER prospect_brands_updated_at
  BEFORE UPDATE ON prospect_brands
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- Do not DROP or re-add prospect_brands_name_test / prospect_brands_logo_https
-- in this transaction. A validating ADD scans every existing row, and this
-- file does not set a lock or statement timeout. A row that was legal at
-- 51c459d would roll the whole boot back. src/db/brand-constraints.sql adds
-- the tightened checks NOT VALID and validates them after this file commits.
-- This file does not delete brand rows. A TEST: cleanup, if one is added,
-- must match test_tag with = or IN (...) and must not use LIKE.

-- Scout's selection rubric (docs/PROTOTYPE_PLAY.md). One row per agent signal.
-- Rubric versions are immutable. ON CONFLICT DO NOTHING keeps version 1 as
-- first written. A scoring change is a new version, not an edit of v1.
CREATE TABLE IF NOT EXISTS prototype_rubric_meta (
  version          INTEGER PRIMARY KEY,
  min_score        INTEGER NOT NULL,
  max_picks        INTEGER NOT NULL,
  never_auto_pick  TEXT[] NOT NULL,
  st_allow         TEXT[] NOT NULL,
  spec_ref         TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS prototype_rubric (
  id        SERIAL PRIMARY KEY,
  version   INTEGER NOT NULL,
  agent     TEXT NOT NULL,
  signal    TEXT NOT NULL,
  points    INTEGER NOT NULL,
  tie_rank  INTEGER NOT NULL,
  is_gap    BOOLEAN NOT NULL DEFAULT FALSE
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_prototype_rubric_key
  ON prototype_rubric (version, agent, signal);

INSERT INTO prototype_rubric_meta (version, min_score, max_picks, never_auto_pick, st_allow, spec_ref)
VALUES (
  1,
  40,
  2,
  ARRAY['bookkeeping'],
  ARRAY['estimate_followup', 'review_requests'],
  'docs/PROTOTYPE_PLAY.md'
)
ON CONFLICT (version) DO NOTHING;

INSERT INTO prototype_rubric (version, agent, signal, points, tie_rank, is_gap)
VALUES
  (1, 'estimate_followup', 'free_estimate', 25, 1, FALSE),
  (1, 'estimate_followup', 'financing', 20, 1, FALSE),
  (1, 'estimate_followup', 'rv_slow_quote', 25, 1, TRUE),
  (1, 'estimate_followup', 'contact_form_only', 5, 1, TRUE),
  (1, 'estimate_followup', 'maint_plan', 5, 1, FALSE),
  (1, 'estimate_followup', 'fsm_jobber_hcp', 10, 1, FALSE),
  (1, 'estimate_followup', 'fsm_none', 5, 1, TRUE),
  (1, 'estimate_followup', 'size_sweet', 10, 1, FALSE),
  (1, 'estimate_followup', 'size_big', 5, 1, FALSE),
  (1, 'estimate_followup', 'hvac', 10, 1, FALSE),
  (1, 'speed_to_lead', 'free_estimate', 10, 2, FALSE),
  (1, 'speed_to_lead', 'financing', 5, 2, FALSE),
  (1, 'speed_to_lead', 'rv_slow_quote', 10, 2, TRUE),
  (1, 'speed_to_lead', 'rv_missed_call', 15, 2, TRUE),
  (1, 'speed_to_lead', 'no_booking', 10, 2, TRUE),
  (1, 'speed_to_lead', 'contact_form_only', 25, 2, TRUE),
  (1, 'speed_to_lead', 'no_chat', 15, 2, TRUE),
  (1, 'speed_to_lead', 'closed_after_hours', 5, 2, TRUE),
  (1, 'speed_to_lead', 'fsm_jobber_hcp', 5, 2, FALSE),
  (1, 'speed_to_lead', 'fsm_none', 5, 2, TRUE),
  (1, 'speed_to_lead', 'size_sweet', 10, 2, FALSE),
  (1, 'speed_to_lead', 'size_big', 5, 2, FALSE),
  (1, 'speed_to_lead', 'hvac', 5, 2, FALSE),
  (1, 'receptionist', 'rv_missed_call', 30, 3, TRUE),
  (1, 'receptionist', 'rv_scheduling', 5, 3, TRUE),
  (1, 'receptionist', 'no_booking', 5, 3, TRUE),
  (1, 'receptionist', 'no_chat', 10, 3, TRUE),
  (1, 'receptionist', 'closed_after_hours', 20, 3, TRUE),
  (1, 'receptionist', 'fsm_none', 5, 3, TRUE),
  (1, 'receptionist', 'size_sweet', 10, 3, FALSE),
  (1, 'receptionist', 'size_big', 10, 3, FALSE),
  (1, 'receptionist', 'hvac', 5, 3, FALSE),
  (1, 'scheduling', 'rv_scheduling', 25, 4, TRUE),
  (1, 'scheduling', 'no_booking', 25, 4, TRUE),
  (1, 'scheduling', 'contact_form_only', 10, 4, TRUE),
  (1, 'scheduling', 'fsm_none', 10, 4, TRUE),
  (1, 'scheduling', 'size_sweet', 10, 4, FALSE),
  (1, 'scheduling', 'hvac', 5, 4, FALSE),
  (1, 'review_requests', 'no_review_tool', 30, 5, TRUE),
  (1, 'review_requests', 'small_good_rating', 20, 5, TRUE),
  (1, 'review_requests', 'fsm_jobber_hcp', 5, 5, FALSE),
  (1, 'review_requests', 'size_sweet', 10, 5, FALSE),
  (1, 'review_requests', 'hvac', 5, 5, FALSE),
  (1, 'maint_renewal', 'maint_plan', 35, 6, FALSE),
  (1, 'maint_renewal', 'fsm_jobber_hcp', 10, 6, FALSE),
  (1, 'maint_renewal', 'size_sweet', 10, 6, FALSE),
  (1, 'maint_renewal', 'size_big', 10, 6, FALSE),
  (1, 'maint_renewal', 'hvac', 10, 6, FALSE),
  (1, 'dispatch', 'rv_scheduling', 15, 7, TRUE),
  (1, 'dispatch', 'fsm_none', 10, 7, TRUE),
  (1, 'dispatch', 'size_sweet', 5, 7, FALSE),
  (1, 'dispatch', 'size_big', 15, 7, FALSE),
  (1, 'dispatch', 'hvac', 5, 7, FALSE),
  (1, 'bookkeeping', 'fsm_none', 5, 8, TRUE),
  (1, 'bookkeeping', 'size_sweet', 5, 8, FALSE)
ON CONFLICT (version, agent, signal) DO NOTHING;

-- Branded prototype issued from a proposal draft (on unless
-- FF_PROTOTYPE_ON_DRAFT is false) or from the CRM. Keyed to the prospect
-- (the shop), not a proposal version. At most one active row per prospect.
-- The raw token is not stored: the server recomputes it from nonce with an
-- HMAC keyed by CRM_API_KEY (src/prototypes/tokens.js) and checks token_hash.
-- Wordmark and hex colors only: this table has no image column.
-- This block does not UPDATE existing rows.
CREATE TABLE IF NOT EXISTS prototypes (
  id               SERIAL PRIMARY KEY,
  prospect_id      INTEGER NOT NULL REFERENCES prospects(id) ON DELETE CASCADE,
  agent_type       TEXT NOT NULL,
  brand_name       TEXT NOT NULL,
  color_primary    TEXT NOT NULL,
  color_secondary  TEXT NOT NULL,
  token_hash       BYTEA NOT NULL UNIQUE,
  nonce            BYTEA,
  issued_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at       TIMESTAMPTZ NOT NULL,
  revoked_at       TIMESTAMPTZ,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT prototypes_color_primary_hex CHECK (color_primary ~ '^#[0-9a-fA-F]{6}$'),
  CONSTRAINT prototypes_color_secondary_hex CHECK (color_secondary ~ '^#[0-9a-fA-F]{6}$'),
  CONSTRAINT prototypes_expires_14d CHECK (expires_at = issued_at + INTERVAL '336 hours')
);

ALTER TABLE prototypes ADD COLUMN IF NOT EXISTS nonce BYTEA;

-- CREATE TABLE IF NOT EXISTS does not add a check to a table that already
-- exists. NOT VALID skips the scan of current rows. Validation runs after
-- commit in brand-constraints.sql. This block does not UPDATE rows.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'prototypes_brand_name_chars'
  ) THEN
    ALTER TABLE prototypes
      ADD CONSTRAINT prototypes_brand_name_chars CHECK (
        char_length(brand_name) BETWEEN 1 AND 120
        AND brand_name !~ U&'[[:cntrl:]<>\200B-\200F\202A-\202E\2060-\2064\2066-\2069\FEFF]'
      ) NOT VALID;
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS idx_prototypes_one_active
  ON prototypes (prospect_id)
  WHERE revoked_at IS NULL;

-- ═══════════════════════════════════════════════════════════════════════════
-- Pilot #1 CSV intake (idempotent — applied on every boot).
-- Shop row plus open estimates. No free-text notes column. No mailbox token.
-- Re-uploads upsert on (customer_id, source_estimate_id).
-- Deleting a customer cascades to that customer's estimates. The opt-out
-- suppression list has no foreign key, so those rows stay under the old
-- customer id. Deleting estimates does not clear suppressions.
-- This file does not UPDATE these tables and does not send mail.
-- live_send_enabled defaults false. No statement here sets it true.
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS pilot_customers (
  id                 SERIAL PRIMARY KEY,
  name               TEXT NOT NULL,
  live_send_enabled  BOOLEAN NOT NULL DEFAULT FALSE,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT pilot_customers_name_check CHECK (
    char_length(btrim(name)) BETWEEN 1 AND 120
    AND name !~ '[[:cntrl:]]'
  )
);

ALTER TABLE pilot_customers
  ADD COLUMN IF NOT EXISTS live_send_enabled BOOLEAN NOT NULL DEFAULT FALSE;

DROP TRIGGER IF EXISTS pilot_customers_updated_at ON pilot_customers;
CREATE TRIGGER pilot_customers_updated_at
  BEFORE UPDATE ON pilot_customers
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE TABLE IF NOT EXISTS pilot_open_estimates (
  id                    SERIAL PRIMARY KEY,
  customer_id           INTEGER NOT NULL REFERENCES pilot_customers(id) ON DELETE CASCADE,
  source_estimate_id    TEXT NOT NULL,
  homeowner_first_name  TEXT,
  email                 TEXT NOT NULL,
  job_type              TEXT,
  amount                NUMERIC(12,2),
  estimate_date         DATE,
  status                TEXT NOT NULL DEFAULT 'open',
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT pilot_open_estimates_source_check CHECK (
    char_length(source_estimate_id) BETWEEN 1 AND 80
    AND source_estimate_id !~ '[[:cntrl:][:space:]]'
  ),
  CONSTRAINT pilot_open_estimates_name_check CHECK (
    homeowner_first_name IS NULL OR (
      char_length(homeowner_first_name) BETWEEN 1 AND 60
      AND homeowner_first_name !~ U&'[[:cntrl:]\0080-\009F\200B-\200F\202A-\202E\2060-\2064\2066-\2069\FEFF]'
      AND position('@' IN homeowner_first_name) = 0
    )
  ),
  CONSTRAINT pilot_open_estimates_email_check CHECK (
    char_length(email) BETWEEN 3 AND 254
    AND position('@' IN email) > 1
  ),
  CONSTRAINT pilot_open_estimates_job_check CHECK (
    job_type IS NULL OR (
      char_length(job_type) BETWEEN 1 AND 80
      AND job_type !~ U&'[[:cntrl:]\0080-\009F\200B-\200F\202A-\202E\2060-\2064\2066-\2069\FEFF]'
    )
  ),
  CONSTRAINT pilot_open_estimates_amount_check CHECK (
    amount IS NULL OR (amount >= 0 AND amount <= 99999999.99)
  ),
  CONSTRAINT pilot_open_estimates_status_check CHECK (
    status IN ('open', 'sold', 'lost', 'expired', 'opted_out')
  )
);

-- Unique key for idempotent re-uploads. One row per shop per source estimate.
CREATE UNIQUE INDEX IF NOT EXISTS idx_pilot_open_estimates_customer_source
  ON pilot_open_estimates (customer_id, source_estimate_id);

DROP TRIGGER IF EXISTS pilot_open_estimates_updated_at ON pilot_open_estimates;
CREATE TRIGGER pilot_open_estimates_updated_at
  BEFORE UPDATE ON pilot_open_estimates
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- CREATE TABLE IF NOT EXISTS does not change a check that an earlier boot
-- already added. These extra checks close that gap for bidi, zero-width, and
-- C1 characters. NOT VALID does not scan existing rows, so a legacy hostile
-- name does not roll this transaction back. Validation runs after commit in
-- estimate-constraints.sql. This block does not UPDATE rows.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'pilot_open_estimates_name_hostile_check'
  ) THEN
    ALTER TABLE pilot_open_estimates
      ADD CONSTRAINT pilot_open_estimates_name_hostile_check CHECK (
        homeowner_first_name IS NULL
        OR homeowner_first_name !~ U&'[[:cntrl:]\0080-\009F\200B-\200F\202A-\202E\2060-\2064\2066-\2069\FEFF]'
      ) NOT VALID;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'pilot_open_estimates_job_hostile_check'
  ) THEN
    ALTER TABLE pilot_open_estimates
      ADD CONSTRAINT pilot_open_estimates_job_hostile_check CHECK (
        job_type IS NULL
        OR job_type !~ U&'[[:cntrl:]\0080-\009F\200B-\200F\202A-\202E\2060-\2064\2066-\2069\FEFF]'
      ) NOT VALID;
  END IF;
END $$;

-- Opt-out emails for one shop. Survives estimate delete, re-upload, and
-- customer delete. No foreign key: a deleted shop leaves these rows keyed to
-- the old customer id. A new shop gets a new id and does not inherit them.
-- Keyed by the normalized (lowercase) email, stored as plaintext.
-- A keyed HMAC of that email is a follow-up; this file does not hash.
CREATE TABLE IF NOT EXISTS pilot_estimate_suppressions (
  id          SERIAL PRIMARY KEY,
  customer_id INTEGER NOT NULL,
  email       TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT pilot_estimate_suppressions_email_check CHECK (
    char_length(email) BETWEEN 3 AND 254
    AND position('@' IN email) > 1
    AND email = lower(email)
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_pilot_estimate_suppressions_customer_email
  ON pilot_estimate_suppressions (customer_id, email);

-- ═══════════════════════════════════════════════════════════════════════════
-- Inbox: replies to proposals, Claude's read of them, and drafted responses.
-- Additive only. No boot UPDATEs.
-- ═══════════════════════════════════════════════════════════════════════════

-- Every message in a lead's conversation after the first email: their replies
-- (direction 'in') and replies Kelby sends from the CRM or from Gmail ('out').
-- The proposal's own first email and follow-ups stay on the proposals row.
CREATE TABLE IF NOT EXISTS inbox_messages (
  id                SERIAL PRIMARY KEY,
  prospect_id       INTEGER NOT NULL REFERENCES prospects(id) ON DELETE CASCADE,
  proposal_id       INTEGER REFERENCES proposals(id) ON DELETE SET NULL,
  direction         TEXT NOT NULL CHECK (direction IN ('in', 'out')),
  dedupe_key        TEXT NOT NULL UNIQUE,          -- Gmail id, else a hash of sender/date/subject/body
  gmail_id          TEXT,
  thread_id         TEXT,
  header_message_id TEXT,                          -- RFC Message-ID, for In-Reply-To on our reply
  from_addr         TEXT,
  to_addr           TEXT,
  subject           TEXT,
  body              TEXT,
  is_auto           BOOLEAN NOT NULL DEFAULT FALSE, -- auto-reply / out-of-office
  received_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at        TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_inbox_messages_prospect ON inbox_messages(prospect_id, received_at);
CREATE INDEX IF NOT EXISTS idx_inbox_messages_thread ON inbox_messages(thread_id);

-- One row per inbound message that needs a look: Claude's summary, suggested
-- next steps, and (when a reply makes sense) a drafted response to review.
-- status: queued | triaging | rewriting | ready | fyi | failed | sent | handled | discarded
CREATE TABLE IF NOT EXISTS inbox_items (
  id             SERIAL PRIMARY KEY,
  prospect_id    INTEGER NOT NULL REFERENCES prospects(id) ON DELETE CASCADE,
  proposal_id    INTEGER REFERENCES proposals(id) ON DELETE SET NULL,
  message_id     INTEGER NOT NULL REFERENCES inbox_messages(id) ON DELETE CASCADE,
  status         TEXT NOT NULL DEFAULT 'queued',
  kind           TEXT,                              -- interested | question | not_now | booked | auto_reply | opt_out | not_interested | referral | bounce | other
  label          TEXT,
  summary        TEXT,
  asks           JSONB NOT NULL DEFAULT '[]'::jsonb,
  timing         TEXT,
  mood           TEXT,
  prep           JSONB NOT NULL DEFAULT '[]'::jsonb,
  suggestions    JSONB NOT NULL DEFAULT '[]'::jsonb, -- [{action, label, stage?, date?, text?}]
  applied        JSONB NOT NULL DEFAULT '{}'::jsonb, -- {"<index>": "<applied at>"}
  notice         TEXT,
  reply_to       TEXT,
  reply_subject  TEXT,
  reply_body     TEXT,
  ai_original    TEXT,
  instructions   TEXT,
  model          TEXT,
  cost_usd       NUMERIC(10,4) DEFAULT 0,
  error          TEXT,
  handled_note   TEXT,
  reviewed_at    TIMESTAMPTZ,
  triaged_at     TIMESTAMPTZ,
  sent_at        TIMESTAMPTZ,
  sent_message_id INTEGER REFERENCES inbox_messages(id) ON DELETE SET NULL,
  created_at     TIMESTAMPTZ DEFAULT NOW(),
  updated_at     TIMESTAMPTZ DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_inbox_items_message ON inbox_items(message_id);
CREATE INDEX IF NOT EXISTS idx_inbox_items_status ON inbox_items(status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_inbox_items_prospect ON inbox_items(prospect_id, created_at DESC);

DROP TRIGGER IF EXISTS inbox_items_updated_at ON inbox_items;
CREATE TRIGGER inbox_items_updated_at
  BEFORE UPDATE ON inbox_items
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- Server feature flags. Seeded off, except FF_PROTOTYPE_ON_DRAFT, which is
-- seeded on (Kelby, Oct 20). A re-boot inserts missing names only.
-- ON CONFLICT DO NOTHING does not update enabled, updated_at, or updated_by.
-- FF_PILOT_ESTIMATE_SMS and FF_CAMPAIGN_OPEN_PIXEL are env-only (exactly
-- "true") and are not seeded. A row left from an older boot is ignored.
-- FF_PILOT_ESTIMATE_LIVE_SEND stays env-only and is not seeded.
-- FF_HIDE_WATERMARK is test-only and is not seeded.
CREATE TABLE IF NOT EXISTS feature_flags (
  name       TEXT PRIMARY KEY,
  enabled    BOOLEAN NOT NULL DEFAULT false,
  updated_at TIMESTAMPTZ,
  updated_by TEXT
);

-- Concurrent updates of one flag are last-write-wins. The API locks the
-- row with SELECT … FOR UPDATE and inserts the audit row in that transaction.
CREATE TABLE IF NOT EXISTS feature_flag_audit (
  id         SERIAL PRIMARY KEY,
  flag       TEXT,
  old_value  BOOLEAN,
  new_value  BOOLEAN,
  actor      TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

INSERT INTO feature_flags (name, enabled)
VALUES
  ('FF_PILOT_ESTIMATE_RECOVERY', false),
  ('FF_PILOT_LINK_ON_ONEPAGER', false),
  ('FF_PROTOTYPE_GALLERY', false),
  ('FF_LIVE_CHAT_DEMO', false),
  ('FF_CAMPAIGNS', false),
  ('FF_PROTOTYPE_ON_DRAFT', true)
ON CONFLICT (name) DO NOTHING;

-- Campaigns slice 1 (F-006). Additive and idempotent. Applied on every boot.
-- Tracking only: these statements do not INSERT, UPDATE, or DELETE existing
-- rows, and they do not send mail. No pixel table and no /o route.
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS campaigns (
  id           SERIAL PRIMARY KEY,
  name         TEXT NOT NULL,
  channel      TEXT NOT NULL,
  segment      TEXT,
  offer_hook   TEXT,
  start_date   DATE,
  end_date     DATE,
  status       TEXT NOT NULL DEFAULT 'draft',
  cost_cents   INTEGER,
  notes        TEXT,
  created_by   TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT campaigns_channel_check CHECK (
    channel IN ('email', 'phone', 'sms', 'prototype_link', 'in_person', 'referral', 'other')
  ),
  CONSTRAINT campaigns_status_check CHECK (
    status IN ('draft', 'active', 'paused', 'ended')
  )
);

CREATE TABLE IF NOT EXISTS campaign_variants (
  id              SERIAL PRIMARY KEY,
  campaign_id     INTEGER NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  label           TEXT NOT NULL,
  hook_summary    TEXT,
  prototype_type  TEXT,
  CONSTRAINT campaign_variants_label_unique UNIQUE (campaign_id, label)
);

CREATE TABLE IF NOT EXISTS campaign_leads (
  id           SERIAL PRIMARY KEY,
  lead_id      INTEGER NOT NULL REFERENCES prospects(id) ON DELETE CASCADE,
  campaign_id  INTEGER NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  variant_id   INTEGER REFERENCES campaign_variants(id) ON DELETE SET NULL,
  enrolled_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT campaign_leads_lead_campaign_unique UNIQUE (lead_id, campaign_id)
);

-- No free-text column. external_ref is a future Gmail thread id, not a note.
-- revenue_cents is allowed only on won / mvp_sold.
-- machine_open is true only when type = opened.
CREATE TABLE IF NOT EXISTS campaign_touches (
  id             SERIAL PRIMARY KEY,
  lead_id        INTEGER NOT NULL REFERENCES prospects(id) ON DELETE CASCADE,
  campaign_id    INTEGER REFERENCES campaigns(id) ON DELETE SET NULL,
  variant_id     INTEGER REFERENCES campaign_variants(id) ON DELETE SET NULL,
  type           TEXT NOT NULL,
  channel        TEXT,
  occurred_at    TIMESTAMPTZ NOT NULL,
  source         TEXT NOT NULL,
  machine_open   BOOLEAN NOT NULL DEFAULT FALSE,
  external_ref   TEXT,
  revenue_cents  INTEGER,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT campaign_touches_type_check CHECK (
    type IN (
      'sent', 'opened', 'replied', 'call_logged', 'call_booked',
      'prototype_viewed', 'prototype_cta_clicked', 'proposal_sent',
      'won', 'lost', 'mvp_sold', 'estimate_recovered'
    )
  ),
  CONSTRAINT campaign_touches_channel_check CHECK (
    channel IS NULL OR channel IN (
      'email', 'phone', 'sms', 'prototype_link', 'in_person', 'referral', 'other'
    )
  ),
  CONSTRAINT campaign_touches_source_check CHECK (
    source IN ('manual', 'gmail_sync', 'system', 'pixel')
  ),
  CONSTRAINT campaign_touches_machine_open_check CHECK (
    machine_open = FALSE OR type = 'opened'
  ),
  CONSTRAINT campaign_touches_revenue_check CHECK (
    revenue_cents IS NULL OR (
      type IN ('won', 'mvp_sold') AND revenue_cents >= 0
    )
  ),
  -- Prototype views and CTA clicks are recorded by the system, never by hand.
  CONSTRAINT campaign_touches_manual_type_check CHECK (
    NOT (source = 'manual' AND type IN ('prototype_viewed', 'prototype_cta_clicked'))
  )
);

CREATE INDEX IF NOT EXISTS idx_campaign_touches_lead_occurred
  ON campaign_touches (lead_id, occurred_at);
CREATE INDEX IF NOT EXISTS idx_campaign_touches_campaign
  ON campaign_touches (campaign_id, occurred_at);
CREATE INDEX IF NOT EXISTS idx_campaign_leads_campaign
  ON campaign_leads (campaign_id);
CREATE INDEX IF NOT EXISTS idx_campaign_variants_campaign
  ON campaign_variants (campaign_id);

-- Channel defaults to the campaign channel when the insert leaves it null.
CREATE OR REPLACE FUNCTION campaign_touches_default_channel()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF NEW.channel IS NULL AND NEW.campaign_id IS NOT NULL THEN
    SELECT c.channel INTO NEW.channel FROM campaigns c WHERE c.id = NEW.campaign_id;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS campaign_touches_default_channel ON campaign_touches;
CREATE TRIGGER campaign_touches_default_channel
  BEFORE INSERT ON campaign_touches
  FOR EACH ROW EXECUTE FUNCTION campaign_touches_default_channel();

-- Read-only projection of every proposal send and reply. Summit (Oct 16):
-- real rows are in this view. sent_at, followup1_sent_at, and
-- followup2_sent_at count as sent touches. replied_at counts as replied,
-- which is the Responded numerator. Channel email. Source system. No campaign.
-- This view does not INSERT, UPDATE, or DELETE proposals.
CREATE OR REPLACE VIEW v_campaign_backfill_touches AS
SELECT
  'proposal'::text AS origin,
  (p.id::bigint * 10 + 1) AS source_id,
  p.prospect_id AS lead_id,
  NULL::integer AS campaign_id,
  NULL::integer AS variant_id,
  'sent'::text AS type,
  'email'::text AS channel,
  p.sent_at AS occurred_at,
  'system'::text AS source,
  FALSE AS machine_open,
  NULL::text AS external_ref,
  NULL::integer AS revenue_cents
FROM proposals p
WHERE p.sent_at IS NOT NULL
UNION ALL
SELECT
  'proposal'::text,
  (p.id::bigint * 10 + 2),
  p.prospect_id,
  NULL::integer,
  NULL::integer,
  'sent'::text,
  'email'::text,
  p.followup1_sent_at,
  'system'::text,
  FALSE,
  NULL::text,
  NULL::integer
FROM proposals p
WHERE p.followup1_sent_at IS NOT NULL
UNION ALL
SELECT
  'proposal'::text,
  (p.id::bigint * 10 + 3),
  p.prospect_id,
  NULL::integer,
  NULL::integer,
  'sent'::text,
  'email'::text,
  p.followup2_sent_at,
  'system'::text,
  FALSE,
  NULL::text,
  NULL::integer
FROM proposals p
WHERE p.followup2_sent_at IS NOT NULL
UNION ALL
SELECT
  'proposal'::text,
  (p.id::bigint * 10 + 4),
  p.prospect_id,
  NULL::integer,
  NULL::integer,
  'replied'::text,
  'email'::text,
  p.replied_at,
  'system'::text,
  FALSE,
  NULL::text,
  NULL::integer
FROM proposals p
WHERE p.replied_at IS NOT NULL;

-- pilot_events_type_check is not widened. Today only estimate_recovered is
-- both a pilot event and a campaign touch type. demo_view and step_* stay out
-- of the touch stream. prototype_viewed, prototype_cta_clicked, call_booked,
-- and mvp_sold are not emitted on pilot_events yet; those rows live in
-- campaign_touches. The UNION arm keeps this view from being auto-updatable.
CREATE OR REPLACE VIEW v_campaign_pilot_event_touches AS
SELECT
  'pilot'::text AS origin,
  e.id::bigint AS source_id,
  e.prospect_id AS lead_id,
  NULL::integer AS campaign_id,
  NULL::integer AS variant_id,
  e.event_type AS type,
  NULL::text AS channel,
  e.created_at AS occurred_at,
  'system'::text AS source,
  FALSE AS machine_open,
  NULL::text AS external_ref,
  NULL::integer AS revenue_cents
FROM pilot_events e
WHERE e.prospect_id IS NOT NULL
  AND e.event_type = 'estimate_recovered'
UNION ALL
SELECT
  'pilot'::text,
  e.id::bigint,
  e.prospect_id,
  NULL::integer,
  NULL::integer,
  e.event_type,
  NULL::text,
  e.created_at,
  'system'::text,
  FALSE,
  NULL::text,
  NULL::integer
FROM pilot_events e
WHERE FALSE;

-- Effective stream = campaign_touches UNION the read-only views.
-- Opens are in the stream for the display metric. Attribution ignores them.
CREATE OR REPLACE VIEW v_campaign_effective_touches AS
SELECT
  'touch'::text AS origin,
  t.id::bigint AS source_id,
  t.lead_id,
  t.campaign_id,
  t.variant_id,
  t.type,
  t.channel,
  t.occurred_at,
  t.source,
  t.machine_open,
  t.external_ref,
  t.revenue_cents
FROM campaign_touches t
UNION ALL
SELECT
  origin, source_id, lead_id, campaign_id, variant_id, type, channel,
  occurred_at, source, machine_open, external_ref, revenue_cents
FROM v_campaign_backfill_touches
UNION ALL
SELECT
  origin, source_id, lead_id, campaign_id, variant_id, type, channel,
  occurred_at, source, machine_open, external_ref, revenue_cents
FROM v_campaign_pilot_event_touches;

-- Last-touch (default) or first-touch, computed on read. Not stored.
-- Qualifying prior touches are the tie-order types only. opened and lost are
-- never inputs. won, mvp_sold, and estimate_recovered are conversion events:
-- they are attributed, and they are not prior-touch qualifiers, so a
-- conversion cannot credit itself. call_booked is a conversion when it is the
-- event being attributed (excluded by identity) and a qualifier for a later
-- conversion. Window is 90 days, occurred_at <= the conversion.
-- Tie order at the same timestamp: non-null campaign_id, then
-- call_booked > replied > prototype_cta_clicked > prototype_viewed >
-- call_logged > proposal_sent > sent, then the newer enrolled_at, then the
-- lower source_id. A qualifier with no campaign falls back to the lead's
-- single active campaign in that channel. Zero or several is unattributed.
CREATE OR REPLACE FUNCTION campaign_attribute_conversion(
  p_lead_id integer,
  p_occurred_at timestamptz,
  p_exclude_origin text,
  p_exclude_id bigint,
  p_model text
)
RETURNS TABLE (
  origin text,
  source_id bigint,
  campaign_id integer,
  variant_id integer,
  channel text,
  unattributed boolean
)
LANGUAGE plpgsql
STABLE
SET search_path = public
AS $$
DECLARE
  chosen record;
  fallback_count integer;
  fallback_campaign integer;
  fallback_variant integer;
BEGIN
  IF p_model IS NULL OR p_model NOT IN ('first', 'last') THEN
    RAISE EXCEPTION 'invalid attribution model';
  END IF;

  SELECT
    t.origin,
    t.source_id,
    t.campaign_id,
    t.variant_id,
    t.channel,
    t.occurred_at,
    t.type,
    cl.enrolled_at
  INTO chosen
  FROM v_campaign_effective_touches t
  LEFT JOIN campaign_leads cl
    ON cl.lead_id = t.lead_id
   AND cl.campaign_id = t.campaign_id
  WHERE t.lead_id = p_lead_id
    AND t.type IN (
      'sent', 'call_logged', 'replied', 'call_booked',
      'prototype_viewed', 'prototype_cta_clicked', 'proposal_sent'
    )
    AND NOT (
      p_exclude_origin IS NOT NULL
      AND p_exclude_id IS NOT NULL
      AND t.origin = p_exclude_origin
      AND t.source_id = p_exclude_id
    )
    AND t.occurred_at <= p_occurred_at
    AND t.occurred_at >= p_occurred_at - INTERVAL '90 days'
  ORDER BY
    CASE WHEN p_model = 'first' THEN t.occurred_at END ASC,
    CASE WHEN p_model = 'last' THEN t.occurred_at END DESC,
    CASE WHEN t.campaign_id IS NULL THEN 1 ELSE 0 END ASC,
    CASE t.type
      WHEN 'call_booked' THEN 1
      WHEN 'replied' THEN 2
      WHEN 'prototype_cta_clicked' THEN 3
      WHEN 'prototype_viewed' THEN 4
      WHEN 'call_logged' THEN 5
      WHEN 'proposal_sent' THEN 6
      WHEN 'sent' THEN 7
      ELSE 100
    END ASC,
    cl.enrolled_at DESC NULLS LAST,
    t.source_id ASC,
    t.origin ASC
  LIMIT 1;

  IF NOT FOUND THEN
    origin := NULL;
    source_id := NULL;
    campaign_id := NULL;
    variant_id := NULL;
    channel := NULL;
    unattributed := TRUE;
    RETURN NEXT;
    RETURN;
  END IF;

  IF chosen.campaign_id IS NOT NULL THEN
    origin := chosen.origin;
    source_id := chosen.source_id;
    campaign_id := chosen.campaign_id;
    variant_id := chosen.variant_id;
    channel := chosen.channel;
    unattributed := FALSE;
    RETURN NEXT;
    RETURN;
  END IF;

  SELECT COUNT(*)::int, MIN(c.id), MIN(cl.variant_id)
    INTO fallback_count, fallback_campaign, fallback_variant
    FROM campaigns c
    JOIN campaign_leads cl
      ON cl.campaign_id = c.id
     AND cl.lead_id = p_lead_id
   WHERE c.status = 'active'
     AND c.channel IS NOT DISTINCT FROM chosen.channel;

  origin := chosen.origin;
  source_id := chosen.source_id;
  channel := chosen.channel;
  IF fallback_count = 1 THEN
    campaign_id := fallback_campaign;
    variant_id := fallback_variant;
    unattributed := FALSE;
  ELSE
    campaign_id := NULL;
    variant_id := NULL;
    unattributed := TRUE;
  END IF;
  RETURN NEXT;
END;
$$;

-- BEGIN chat demo (F-007).
-- Idempotent. Applied on every boot. No clock defaults in this section.
-- Caps match CHAT_CAPS in src/chatdemo/caps.js. The ceiling is not stored.

CREATE TABLE IF NOT EXISTS prototype_facts (
  id           SERIAL PRIMARY KEY,
  prospect_id  INTEGER NOT NULL REFERENCES prospects(id) ON DELETE CASCADE,
  field        TEXT NOT NULL,
  value        TEXT NOT NULL,
  source       TEXT NOT NULL,
  source_url   TEXT,
  snippet      TEXT,
  captured_at  TIMESTAMPTZ NOT NULL,
  test_tag     TEXT NOT NULL,
  CONSTRAINT prototype_facts_field_check CHECK (
    field IN (
      'business_name', 'services', 'service_area', 'phone', 'address', 'hours',
      'emergency_247', 'financing', 'free_estimate', 'maintenance_plan', 'price',
      'license', 'license_number', 'insurance', 'bonding', 'warranty', 'guarantee',
      'years_in_business', 'time_zone'
    )
  ),
  CONSTRAINT prototype_facts_value_len CHECK (char_length(value) BETWEEN 1 AND 500),
  CONSTRAINT prototype_facts_value_chars CHECK (
    value !~ U&'[[:cntrl:]<>\200B-\200F\202A-\202E\2060-\2064\2066-\2069\FEFF]'
  ),
  CONSTRAINT prototype_facts_yes_fields CHECK (
    field NOT IN (
      'free_estimate', 'emergency_247', 'financing', 'maintenance_plan',
      'license', 'insurance', 'bonding'
    )
    OR value = 'yes'
  ),
  CONSTRAINT prototype_facts_source_check CHECK (source IN ('manual', 'cached_research', 'fixture')),
  CONSTRAINT prototype_facts_source_url CHECK (
    source_url IS NULL OR (
      char_length(source_url) BETWEEN 8 AND 300
      AND source_url ~ '^https://'
      AND source_url !~ '://[^/?#]*@'
      AND source_url !~ '[[:space:][:cntrl:]]'
    )
  ),
  CONSTRAINT prototype_facts_research_url CHECK (source <> 'cached_research' OR source_url IS NOT NULL),
  CONSTRAINT prototype_facts_snippet_len CHECK (snippet IS NULL OR char_length(snippet) BETWEEN 1 AND 300),
  CONSTRAINT prototype_facts_research_snippet CHECK (source <> 'cached_research' OR snippet IS NOT NULL),
  CONSTRAINT prototype_facts_tag_check CHECK (
    test_tag ~ '^TEST:[a-z0-9]+(-[a-z0-9]+)*$'
    AND char_length(test_tag) <= 80
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_prototype_facts_prospect_field
  ON prototype_facts (prospect_id, field);

CREATE TABLE IF NOT EXISTS chat_demo_sessions (
  id             UUID PRIMARY KEY,
  prototype_id   INTEGER REFERENCES prototypes(id) ON DELETE CASCADE,
  link_key       TEXT NOT NULL,
  session_hash   BYTEA NOT NULL,
  message_count  INTEGER NOT NULL,
  test_tag       TEXT NOT NULL,
  created_at     TIMESTAMPTZ NOT NULL,
  expires_at     TIMESTAMPTZ NOT NULL,
  CONSTRAINT chat_demo_sessions_message_count_cap CHECK (message_count >= 0 AND message_count <= 20),
  CONSTRAINT chat_demo_sessions_tag_check CHECK (
    char_length(test_tag) <= 80
    AND (
      test_tag ~ '^TEST:[a-z0-9]+(-[a-z0-9]+)*$'
      OR test_tag ~ '^demo-[a-z0-9]+(-[a-z0-9]+)*$'
    )
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_chat_demo_sessions_hash ON chat_demo_sessions (session_hash);

-- BEGIN chat_demo_sessions_tag_check upgrade
-- CREATE TABLE IF NOT EXISTS keeps an older TEST-only check. Drop and re-add
-- so a database that booted an earlier head allows demo-prototype as well.
ALTER TABLE chat_demo_sessions DROP CONSTRAINT IF EXISTS chat_demo_sessions_tag_check;
ALTER TABLE chat_demo_sessions ADD CONSTRAINT chat_demo_sessions_tag_check CHECK (
  char_length(test_tag) <= 80
  AND (
    test_tag ~ '^TEST:[a-z0-9]+(-[a-z0-9]+)*$'
    OR test_tag ~ '^demo-[a-z0-9]+(-[a-z0-9]+)*$'
  )
);
-- END chat_demo_sessions_tag_check upgrade

CREATE TABLE IF NOT EXISTS chat_demo_turns (
  id                  UUID PRIMARY KEY,
  session_id          UUID NOT NULL REFERENCES chat_demo_sessions(id) ON DELETE CASCADE,
  input_chars         INTEGER NOT NULL,
  input_bound_tokens  INTEGER,
  output_tokens       INTEGER,
  cost_usd            NUMERIC(12,6),
  source              TEXT,
  created_at          TIMESTAMPTZ NOT NULL,
  CONSTRAINT chat_demo_turns_input_chars_cap CHECK (input_chars >= 0 AND input_chars <= 500),
  CONSTRAINT chat_demo_turns_input_bound_cap CHECK (
    input_bound_tokens IS NULL OR (input_bound_tokens >= 0 AND input_bound_tokens <= 16000)
  ),
  CONSTRAINT chat_demo_turns_output_tokens_cap CHECK (
    output_tokens IS NULL OR (output_tokens >= 0 AND output_tokens <= 300)
  ),
  CONSTRAINT chat_demo_turns_source_check CHECK (source IS NULL OR source IN ('fixture', 'live'))
);

CREATE TABLE IF NOT EXISTS chat_demo_links (
  link_key       TEXT PRIMARY KEY,
  message_count  INTEGER NOT NULL,
  session_count  INTEGER NOT NULL,
  CONSTRAINT chat_demo_links_message_count_cap CHECK (message_count >= 0 AND message_count <= 100),
  CONSTRAINT chat_demo_links_session_count_cap CHECK (session_count >= 0 AND session_count <= 10)
);

CREATE TABLE IF NOT EXISTS chat_demo_link_days (
  link_key       TEXT NOT NULL,
  day            DATE NOT NULL,
  message_count  INTEGER NOT NULL,
  PRIMARY KEY (link_key, day),
  CONSTRAINT chat_demo_link_days_message_count_cap CHECK (message_count >= 0 AND message_count <= 40)
);

CREATE TABLE IF NOT EXISTS chat_demo_global_days (
  day            DATE PRIMARY KEY,
  session_count  INTEGER NOT NULL,
  CONSTRAINT chat_demo_global_days_session_count_cap CHECK (session_count >= 0 AND session_count <= 300)
);

CREATE TABLE IF NOT EXISTS chat_demo_ip_hours (
  ip_hash     TEXT NOT NULL,
  hour        TIMESTAMPTZ NOT NULL,
  mint_count  INTEGER NOT NULL,
  PRIMARY KEY (ip_hash, hour),
  CONSTRAINT chat_demo_ip_hours_mint_count_cap CHECK (mint_count >= 0 AND mint_count <= 5)
);

CREATE TABLE IF NOT EXISTS chat_demo_ip_days (
  ip_hash     TEXT NOT NULL,
  day         DATE NOT NULL,
  mint_count  INTEGER NOT NULL,
  PRIMARY KEY (ip_hash, day),
  CONSTRAINT chat_demo_ip_days_mint_count_cap CHECK (mint_count >= 0 AND mint_count <= 20)
);

-- One HMAC key per America/Denver day, shared by every process that uses
-- this database. Not derived from CRM_API_KEY. No seed and no UPDATE.
CREATE TABLE IF NOT EXISTS chat_demo_ip_day_keys (
  day        DATE PRIMARY KEY,
  key_bytes  BYTEA NOT NULL,
  CONSTRAINT chat_demo_ip_day_keys_len CHECK (octet_length(key_bytes) = 32)
);

CREATE TABLE IF NOT EXISTS chat_demo_rate_minutes (
  link_key  TEXT NOT NULL,
  ip_hash   TEXT NOT NULL,
  minute    TIMESTAMPTZ NOT NULL,
  count     INTEGER NOT NULL,
  PRIMARY KEY (link_key, ip_hash, minute),
  CONSTRAINT chat_demo_rate_minutes_count_cap CHECK (count >= 0 AND count <= 10)
);

CREATE TABLE IF NOT EXISTS chat_demo_spend_days (
  day               DATE PRIMARY KEY,
  spent_micros      BIGINT NOT NULL,
  reserved_micros   BIGINT NOT NULL,
  overshoot_micros  BIGINT NOT NULL,
  CONSTRAINT chat_demo_spend_days_spent_nonneg CHECK (spent_micros >= 0),
  CONSTRAINT chat_demo_spend_days_reserved_nonneg CHECK (reserved_micros >= 0),
  CONSTRAINT chat_demo_spend_days_overshoot_nonneg CHECK (overshoot_micros >= 0)
);

CREATE TABLE IF NOT EXISTS chat_demo_reservations (
  id             UUID PRIMARY KEY,
  day            DATE NOT NULL,
  turn_id        UUID REFERENCES chat_demo_turns(id) ON DELETE CASCADE,
  status         TEXT NOT NULL,
  amount_micros  BIGINT NOT NULL,
  created_at     TIMESTAMPTZ NOT NULL,
  settled_at     TIMESTAMPTZ,
  expired_at     TIMESTAMPTZ,
  released_at    TIMESTAMPTZ,
  actual_micros  BIGINT,
  CONSTRAINT chat_demo_reservations_status_check CHECK (
    status IN ('reserved', 'settled', 'expired', 'released')
  ),
  CONSTRAINT chat_demo_reservations_amount_nonneg CHECK (amount_micros >= 0),
  CONSTRAINT chat_demo_reservations_actual_nonneg CHECK (actual_micros IS NULL OR actual_micros >= 0)
);

CREATE TABLE IF NOT EXISTS chat_demo_events (
  id            UUID PRIMARY KEY,
  prototype_id  INTEGER,
  session_id    UUID,
  event_type    TEXT NOT NULL,
  chip_id       TEXT,
  tool          TEXT,
  rule          TEXT,
  created_at    TIMESTAMPTZ NOT NULL,
  CONSTRAINT chat_demo_events_type_check CHECK (
    event_type IN (
      'chat_viewed', 'session_started', 'chip_clicked', 'message_sent',
      'tool_card_shown', 'validator_rewrote', 'validator_fallback', 'cap_hit',
      'demo_paused', 'responder_live', 'responder_fixture', 'responder_fallback',
      'spend_overshoot', 'reservation_expired', 'cta_clicked', 'input_bound_exceeded',
      'model_unpriced', 'prompt_over_cap', 'cap_store_unavailable', 'ip_purge_failed',
      'tool_call_dropped'
    )
  ),
  CONSTRAINT chat_demo_events_chip_check CHECK (
    chip_id IS NULL OR chip_id IN (
      'chip_emergency', 'chip_booking', 'chip_price', 'chip_hours', 'chip_area'
    )
  ),
  CONSTRAINT chat_demo_events_tool_check CHECK (
    tool IS NULL OR tool IN (
      'offer_sample_slots', 'flag_emergency', 'capture_lead', 'handoff_to_human'
    )
  )
);

CREATE TABLE IF NOT EXISTS chat_demo_leads (
  id            SERIAL PRIMARY KEY,
  prototype_id  INTEGER,
  session_id    UUID NOT NULL,
  service       TEXT NOT NULL,
  urgency       TEXT NOT NULL,
  test_tag      TEXT NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL,
  CONSTRAINT chat_demo_leads_service_check CHECK (
    service IN ('water_heater', 'furnace', 'general', 'drain')
  ),
  CONSTRAINT chat_demo_leads_urgency_check CHECK (
    urgency IN ('low', 'normal', 'urgent', 'emergency')
  ),
  CONSTRAINT chat_demo_leads_tag_check CHECK (
    test_tag ~ '^TEST:[a-z0-9]+(-[a-z0-9]+)*$'
    OR test_tag ~ '^demo-[a-z0-9]+(-[a-z0-9]+)*$'
  )
);

-- END chat demo (F-007).
