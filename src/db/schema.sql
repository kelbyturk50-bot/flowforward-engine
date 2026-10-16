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
