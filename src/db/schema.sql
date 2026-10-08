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
