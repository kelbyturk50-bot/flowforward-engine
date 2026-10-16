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
ALTER TABLE prospects ADD COLUMN IF NOT EXISTS researched_at  TIMESTAMPTZ;
-- Field-service software cached by proposal research. NULL = unknown, so fit
-- scoring applies no ServiceTitan penalty. Only the value ServiceTitan is
-- penalized. computeFit / rescore read this column and do not fetch.
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
-- this file, with no session timeout. A catalog check runs first so a boot
-- does not lock pilot_tokens when the table, column, or index is already
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
  CONSTRAINT prospect_brands_logo_http CHECK (
    logo_url IS NULL OR (
      char_length(logo_url) BETWEEN 8 AND 300
      AND logo_url ~ '^https?://'
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

-- Re-apply the name and logo checks so a database that already created the
-- first version of these constraints picks up the tighter rules on boot.
ALTER TABLE prospect_brands DROP CONSTRAINT IF EXISTS prospect_brands_name_test;
ALTER TABLE prospect_brands ADD CONSTRAINT prospect_brands_name_test CHECK (
  char_length(name) BETWEEN 6 AND 120
  AND left(name, 5) = 'TEST:'
  AND position('@' IN name) = 0
  AND name !~ U&'[[:cntrl:]<>\200B-\200F\202A-\202E\2060-\2064\2066-\2069\FEFF]'
  AND btrim(substring(name from 6)) ~ '[[:graph:]]'
);
ALTER TABLE prospect_brands DROP CONSTRAINT IF EXISTS prospect_brands_logo_http;
ALTER TABLE prospect_brands ADD CONSTRAINT prospect_brands_logo_http CHECK (
  logo_url IS NULL OR (
    char_length(logo_url) BETWEEN 8 AND 300
    AND logo_url ~ '^https?://'
    AND logo_url !~ '://[^/?#]*@'
    AND logo_url !~ '[[:space:][:cntrl:]]'
    AND logo_url !~ '[''"`();\\<>{}]'
  )
);

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
