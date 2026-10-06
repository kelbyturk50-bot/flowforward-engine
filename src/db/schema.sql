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
