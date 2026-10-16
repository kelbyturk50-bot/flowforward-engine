require('./preload');

// Step 3 of #39. Reversible archive. Disposable Postgres. No live APIs.
// Dry-run stdout is counts only. Fixture names stay in this file and must
// not show up in that stdout.

process.env.EXCLUDED_INDUSTRIES = [
  'Roofing', 'Landscaping', 'Plumbing', 'Electrical', 'Pest Control',
  'Cleaning', 'Painting', 'Gutters', 'Windows', 'Construction',
].join(',');
process.env.TARGET_MARKETS = 'Provo UT';
process.env.MIN_RATING = '0';
process.env.SEND_HOURS = '0,24';
process.env.SEND_DAYS = '0,1,2,3,4,5,6';
process.env.SENDER_ADDRESS = '1 Test Street, Provo, UT 84601';
process.env.CRM_API_KEY = '';

const fs = require('fs');
const path = require('path');
const http = require('http');
const { spawnSync } = require('child_process');
const express = require('express');
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { resetDb, insertProspect, closePool, pool, fakeClaude } = require('./fixtures');
const { applySchema } = require('../src/db/migrate');
const {
  PEST_ARCHIVE_REASON,
  ARCHIVED_LEAD_REASON,
  CATEGORIES,
  BUCKETS,
  TIERS,
  archiveStatement,
  unarchiveSql,
  runApply,
} = require('../src/db/pest-archive');
const { PEST_COMPANY_PATTERN, isPestCompanyName } = require('../src/scoring/industry');
const { rescore } = require('../src/scoring/fit');
const { pickLeads, draftProposal, _setClient } = require('../src/proposals/draft');
const { sendDueFollowups, approveAndSend, _setTransport } = require('../src/proposals/send');
const { runDiscovery, INDUSTRIES } = require('../src/bot/discover');
const { _setSearch } = require('../src/bot/google-places');

const SCRIPT = path.join(__dirname, '../scripts/pest-archive.js');
const TODAY = '2026-10-16';

function grid(overrides) {
  const known = new Set();
  const lines = [];
  for (const category of CATEGORIES) {
    for (const bucket of BUCKETS) {
      for (const tier of TIERS) known.add(`${category} ${bucket} ${tier}`);
    }
  }
  for (const key of Object.keys(overrides)) assert.ok(known.has(key), key);
  for (const key of known) lines.push(`${key} ${overrides[key] || 0}`);
  return lines.join('\n') + '\n';
}

function runScript(mode) {
  return spawnSync(process.execPath, [SCRIPT, mode], { encoding: 'utf8', env: process.env });
}

function assertCountsOnly(stdout) {
  assert.match(stdout, /^(?:[a-z_]+ (?:other_industry|pest_industry) (?:A|B|C|D|none) \d+\n)+$/);
  assert.doesNotMatch(stdout, /TEST:|@|555|Terminix|NNNN|Pestana|Orkin|Exterminator|Alpha|Beta|Epsilon|Zeta|Eta|Theta/i);
}

async function stamp(id) {
  const { rows } = await pool.query(
    `SELECT id, company, industry, email, phone, stage, fit_score, fit_tier,
            archived_at, archive_reason, updated_at
       FROM prospects WHERE id = $1`,
    [id]
  );
  return rows[0];
}

describe('pest-name archive', { concurrency: false }, () => {
  let server;
  let apiBase;
  let claudeCalls = 0;

  before(async () => {
    await resetDb();
    _setClient({
      messages: {
        async create() {
          claudeCalls += 1;
          return fakeClaude().messages.create();
        },
      },
    });
    const app = express();
    app.use(express.json());
    app.use('/api', require('../src/api/auth'));
    app.use('/api/prospects', require('../src/api/prospects'));
    app.use('/api/focus', require('../src/api/focus'));
    app.use('/api/proposals', require('../src/api/proposals'));
    server = http.createServer(app);
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    apiBase = `http://127.0.0.1:${server.address().port}`;
  });

  after(async () => {
    _setClient(null);
    _setTransport(null);
    _setSearch(null);
    if (server) await new Promise(resolve => server.close(resolve));
    await closePool();
  });

  it('adds nullable archive columns and does not archive on boot', async () => {
    const schema = fs.readFileSync(path.join(__dirname, '../src/db/schema.sql'), 'utf8');
    const migrate = fs.readFileSync(path.join(__dirname, '../src/db/migrate.js'), 'utf8');
    const serverSrc = fs.readFileSync(path.join(__dirname, '../src/server.js'), 'utf8');
    const undo = unarchiveSql();
    assert.match(schema, /ADD COLUMN IF NOT EXISTS archived_at/);
    assert.match(schema, /ADD COLUMN IF NOT EXISTS archive_reason/);
    assert.doesNotMatch(schema, /SET archived_at/);
    assert.doesNotMatch(schema, /archive_reason\s*=/);
    assert.doesNotMatch(migrate, /pest-archive/);
    assert.doesNotMatch(serverSrc, /pest-archive/);
    assert.match(undo, /WHERE archive_reason = 'pest-name gate \(#39\)'/);
    assert.doesNotMatch(undo, /DELETE/i);
    assert.doesNotMatch(undo, /LIKE/i);

    const stmt = archiveStatement();
    assert.match(stmt.text, /RETURNING 1/);
    assert.match(stmt.text, /char_length/);
    assert.match(stmt.text, /NOT \(/);
    assert.equal(stmt.text.includes('DELETE'), false);
    assert.equal(stmt.values.includes(PEST_ARCHIVE_REASON), true);
    assert.equal(stmt.values.includes(PEST_COMPANY_PATTERN), true);

    const cols = await pool.query(
      `SELECT column_name, data_type, is_nullable
         FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'prospects'
          AND column_name IN ('archived_at', 'archive_reason')
        ORDER BY column_name`
    );
    assert.deepEqual(cols.rows, [
      { column_name: 'archive_reason', data_type: 'text', is_nullable: 'YES' },
      { column_name: 'archived_at', data_type: 'timestamp with time zone', is_nullable: 'YES' },
    ]);

    await resetDb();
    const row = await insertProspect({
      google_place_id: 'test-place-boot-archive',
      company: 'TEST: Alpha Pest Control',
      industry: 'HVAC',
      email: 'test+boot-archive@example.com',
    });
    await applySchema();
    const after = await stamp(row.id);
    assert.equal(after.archived_at, null);
    assert.equal(after.archive_reason, null);
    assert.equal(after.company, row.company);

    const dry = runScript('dry');
    assert.equal(dry.status, 0, dry.stderr);
    assertCountsOnly(dry.stdout);
    assert.equal(dry.stdout, grid({
      'would_archive other_industry none': 1,
    }));
  });

  it('archives with the shared predicate, is idempotent, and undoes only that reason', async () => {
    await resetDb();
    const longName = 'N'.repeat(201);
    const shortName = 'B'.repeat(200);
    assert.equal(isPestCompanyName(longName), true);
    assert.equal(isPestCompanyName(shortName), false);

    async function add(place, company, industry, tier, extra = {}) {
      const row = await insertProspect({
        google_place_id: place,
        company,
        industry,
        email: extra.email,
        website: extra.website === undefined ? null : extra.website,
        phone: extra.phone === undefined ? null : extra.phone,
      });
      await pool.query(
        `UPDATE prospects SET fit_tier = $2, fit_score = $3 WHERE id = $1`,
        [row.id, tier, extra.score === undefined ? 80 : extra.score]
      );
      return row.id;
    }

    const alpha = await add('test-place-arch-alpha', 'TEST: Alpha Pest Control', 'HVAC', 'A', {
      email: 'test+alpha@example.com',
    });
    const beta = await add('test-place-arch-beta', 'TEST: Beta Exterminators', 'Plumbing', 'B', {
      email: 'test+beta@example.com',
    });
    const longId = await add('test-place-arch-long', longName, 'HVAC', 'C', {
      email: 'test+long@example.com',
    });
    const terminix = await add('test-place-arch-terminix', 'Terminix', 'Pest Control', 'D', {
      email: 'test+terminix@example.com',
    });
    const epsilon = await add('test-place-arch-epsilon', 'TEST: Epsilon Heating', 'HVAC', 'A', {
      email: 'test+epsilon@example.com',
    });
    const pestana = await add('test-place-arch-pestana', 'Pestana Plumbing', 'Plumbing', 'A', {
      email: 'test+pestana@example.com',
    });
    const street = await add('test-place-arch-street', 'Orkin Street Landscaping', 'Landscaping', 'B', {
      email: 'test+street@example.com',
    });
    const bounded = await add('test-place-arch-bounded', shortName, 'HVAC', 'D', {
      email: 'test+bounded@example.com',
    });
    const eta = await add('test-place-arch-eta', 'TEST: Eta Heating', 'HVAC', null, {
      email: 'test+eta@example.com',
    });
    const zeta = await add('test-place-arch-zeta', 'TEST: Zeta Pest Control', 'HVAC', 'A', {
      email: 'test+zeta@example.com',
    });
    const theta = await add('test-place-arch-theta', 'TEST: Theta Pest', 'Pest Control', 'A', {
      email: 'test+theta@example.com',
    });

    await pool.query(
      `UPDATE prospects SET archived_at = TIMESTAMPTZ '2020-01-02T00:00:00Z', archive_reason = 'manual hold' WHERE id = $1`,
      [zeta]
    );
    await pool.query(
      `UPDATE prospects SET archived_at = TIMESTAMPTZ '2020-03-04T00:00:00Z', archive_reason = $2 WHERE id = $1`,
      [theta, PEST_ARCHIVE_REASON]
    );
    const zetaBefore = await stamp(zeta);
    const thetaBefore = await stamp(theta);
    const beforeCount = await pool.query('SELECT COUNT(*)::int AS n FROM prospects');

    const initial = grid({
      'would_archive other_industry A': 1,
      'would_archive other_industry B': 1,
      'would_archive other_industry C': 1,
      'would_archive pest_industry D': 1,
      'already_pest_archived pest_industry A': 1,
      'skipped_other_reason other_industry A': 1,
      'active_other other_industry A': 2,
      'active_other other_industry B': 1,
      'active_other other_industry D': 1,
      'active_other other_industry none': 1,
    });
    const dry = runScript('dry');
    assert.equal(dry.status, 0, dry.stderr);
    assert.equal(dry.stderr, '');
    assertCountsOnly(dry.stdout);
    assert.equal(dry.stdout, initial);

    const apply = runScript('apply');
    assert.equal(apply.status, 0, apply.stderr);
    assert.equal(apply.stdout, 'archived 4\n');
    assert.doesNotMatch(apply.stdout, /@|TEST:|555/);
    const afterCount = await pool.query('SELECT COUNT(*)::int AS n FROM prospects');
    assert.equal(afterCount.rows[0].n, beforeCount.rows[0].n);

    const matched = new Set([alpha, beta, longId, terminix]);
    const pre = new Set([zeta, theta]);
    const { rows: judged } = await pool.query(
      `SELECT id, company, archived_at, archive_reason, fit_score, email, stage, industry FROM prospects`
    );
    for (const row of judged) {
      if (pre.has(row.id)) continue;
      assert.equal(Boolean(row.archived_at), isPestCompanyName(row.company));
      if (matched.has(row.id)) {
        assert.equal(row.archive_reason, PEST_ARCHIVE_REASON);
        assert.equal(row.fit_score, 80);
        assert.equal(row.email.endsWith('@example.com'), true);
      } else {
        assert.equal(row.archived_at, null);
        assert.equal(row.archive_reason, null);
      }
    }

    const alphaOnce = await stamp(alpha);
    const zetaOnce = await stamp(zeta);
    const thetaOnce = await stamp(theta);
    assert.equal(zetaOnce.archive_reason, 'manual hold');
    assert.equal(new Date(zetaOnce.archived_at).toISOString(), new Date(zetaBefore.archived_at).toISOString());
    assert.equal(new Date(zetaOnce.updated_at).toISOString(), new Date(zetaBefore.updated_at).toISOString());
    assert.equal(thetaOnce.archive_reason, PEST_ARCHIVE_REASON);
    assert.equal(new Date(thetaOnce.archived_at).toISOString(), new Date(thetaBefore.archived_at).toISOString());
    assert.equal(new Date(thetaOnce.updated_at).toISOString(), new Date(thetaBefore.updated_at).toISOString());
    assert.notEqual(alphaOnce.archived_at, null);

    const again = runScript('apply');
    assert.equal(again.status, 0, again.stderr);
    assert.equal(again.stdout, 'archived 0\n');
    const alphaTwice = await stamp(alpha);
    const zetaTwice = await stamp(zeta);
    assert.equal(new Date(alphaTwice.archived_at).toISOString(), new Date(alphaOnce.archived_at).toISOString());
    assert.equal(new Date(alphaTwice.updated_at).toISOString(), new Date(alphaOnce.updated_at).toISOString());
    assert.equal(alphaTwice.fit_score, 80);
    assert.equal(alphaTwice.email, 'test+alpha@example.com');
    assert.equal(zetaTwice.archive_reason, 'manual hold');
    assert.equal(new Date(zetaTwice.archived_at).toISOString(), new Date(zetaBefore.archived_at).toISOString());

    const undo = runScript('undo');
    assert.equal(undo.status, 0, undo.stderr);
    assert.equal(undo.stdout, 'restored 5\n');
    assert.doesNotMatch(undo.stdout, /@|TEST:/);
    for (const id of [...matched, theta]) {
      const row = await stamp(id);
      assert.equal(row.archived_at, null);
      assert.equal(row.archive_reason, null);
      assert.equal(row.fit_score, 80);
    }
    const zetaUndone = await stamp(zeta);
    assert.equal(zetaUndone.archive_reason, 'manual hold');
    assert.equal(new Date(zetaUndone.archived_at).toISOString(), new Date(zetaBefore.archived_at).toISOString());
    assert.equal(zetaUndone.email, 'test+zeta@example.com');

    const afterUndo = runScript('dry');
    assert.equal(afterUndo.status, 0, afterUndo.stderr);
    assertCountsOnly(afterUndo.stdout);
    assert.equal(afterUndo.stdout, grid({
      'would_archive other_industry A': 1,
      'would_archive other_industry B': 1,
      'would_archive other_industry C': 1,
      'would_archive pest_industry A': 1,
      'would_archive pest_industry D': 1,
      'skipped_other_reason other_industry A': 1,
      'active_other other_industry A': 2,
      'active_other other_industry B': 1,
      'active_other other_industry D': 1,
      'active_other other_industry none': 1,
    }));

    const redo = runScript('apply');
    assert.equal(redo.stdout, 'archived 5\n');
    const zetaRedo = await stamp(zeta);
    assert.equal(zetaRedo.archive_reason, 'manual hold');
    assert.equal(new Date(zetaRedo.archived_at).toISOString(), new Date(zetaBefore.archived_at).toISOString());
    const secondUndo = runScript('undo');
    assert.equal(secondUndo.stdout, 'restored 5\n');
    const thirdUndo = runScript('undo');
    assert.equal(thirdUndo.status, 0, thirdUndo.stderr);
    assert.equal(thirdUndo.stdout, 'restored 0\n');
    const zetaFinal = await stamp(zeta);
    assert.equal(zetaFinal.archive_reason, 'manual hold');
    assert.equal(new Date(zetaFinal.archived_at).toISOString(), new Date(zetaBefore.archived_at).toISOString());
  });

  it('omits archived leads from lists, Today, scoring, and proposals', async () => {
    await resetDb();
    claudeCalls = 0;

    const archivedPest = await insertProspect({
      google_place_id: 'test-place-hide-pest',
      company: 'TEST: Alpha Pest Control',
      industry: 'HVAC',
      email: 'test+hide-pest@example.com',
      website: 'https://hide-pest.example',
      stage: 'found',
    });
    const twin = await insertProspect({
      google_place_id: 'test-place-hide-twin',
      company: 'TEST: Epsilon Heating',
      industry: 'HVAC',
      email: 'test+hide-twin@example.com',
      website: 'https://hide-twin.example',
      stage: 'found',
    });
    await pool.query(
      `UPDATE prospects
          SET fit_tier = 'A', fit_score = 50, next_action_at = $2
        WHERE id = ANY($1::int[])`,
      [[archivedPest.id, twin.id], TODAY]
    );
    const client = await pool.connect();
    try {
      assert.equal(await runApply(client), 1);
    } finally {
      client.release();
    }
    await pool.query(`UPDATE prospects SET fit_score = 1, fit_tier = 'D' WHERE id = $1`, [archivedPest.id]);

    const livePest = await insertProspect({
      google_place_id: 'test-place-hide-live',
      company: 'TEST: Beta Exterminators',
      industry: 'HVAC',
      email: 'test+hide-live@example.com',
      website: 'https://hide-live.example',
      stage: 'found',
    });
    const archivedBenign = await insertProspect({
      google_place_id: 'test-place-hide-benign',
      company: 'TEST: Eta Heating',
      industry: 'HVAC',
      email: 'test+hide-benign@example.com',
      website: null,
      stage: 'contacted',
    });
    const activeQuiet = await insertProspect({
      google_place_id: 'test-place-hide-quiet',
      company: 'TEST: Quiet Heating',
      industry: 'HVAC',
      email: 'test+hide-quiet@example.com',
      website: null,
      phone: null,
      stage: 'contacted',
    });
    const archivedQuiet = await insertProspect({
      google_place_id: 'test-place-hide-archived-quiet',
      company: 'TEST: Quiet Archived Heating',
      industry: 'HVAC',
      email: 'test+hide-archived-quiet@example.com',
      website: null,
      phone: null,
      stage: 'contacted',
    });
    const activeQualified = await insertProspect({
      google_place_id: 'test-place-hide-qualified',
      company: 'TEST: Qualified Heating',
      industry: 'HVAC',
      email: 'test+hide-qualified@example.com',
      website: null,
      stage: 'qualified',
    });
    const archivedQualified = await insertProspect({
      google_place_id: 'test-place-hide-archived-qualified',
      company: 'TEST: Archived Qualified Heating',
      industry: 'HVAC',
      email: 'test+hide-archived-qualified@example.com',
      website: null,
      stage: 'qualified',
    });
    await pool.query(
      `UPDATE prospects SET fit_tier = 'A', fit_score = 100, est_value = 5 WHERE id = $1`,
      [activeQualified.id]
    );
    await pool.query(
      `UPDATE prospects SET fit_tier = 'A', fit_score = 100, est_value = 10, archived_at = NOW(), archive_reason = 'manual hold' WHERE id = $1`,
      [archivedQualified.id]
    );
    await pool.query(
      `UPDATE prospects SET fit_tier = 'B', fit_score = 70,
              last_contacted_at = NOW() - INTERVAL '30 days'
        WHERE id = $1`,
      [activeQuiet.id]
    );
    await pool.query(
      `UPDATE prospects SET fit_tier = 'B', fit_score = 70,
              last_contacted_at = NOW() - INTERVAL '30 days',
              archived_at = NOW(), archive_reason = 'manual hold'
        WHERE id = $1`,
      [archivedQuiet.id]
    );
    await pool.query(
      `UPDATE prospects SET fit_tier = 'A', fit_score = 90, next_action_at = $2,
              archived_at = NOW(), archive_reason = 'manual hold'
        WHERE id = $1`,
      [archivedBenign.id, TODAY]
    );
    await pool.query(
      `UPDATE prospects SET fit_tier = 'A', fit_score = 100 WHERE id = $1`,
      [livePest.id]
    );

    assert.equal(await rescore(), 4);
    assert.equal(await rescore([archivedPest.id]), 0);
    const pestScore = await stamp(archivedPest.id);
    assert.equal(pestScore.fit_score, 1);
    assert.equal(pestScore.fit_tier, 'D');
    assert.equal(pestScore.archive_reason, PEST_ARCHIVE_REASON);
    const twinScore = await stamp(twin.id);
    assert.equal(twinScore.fit_score, 100);
    assert.equal(twinScore.fit_tier, 'A');

    async function get(urlPath) {
      const res = await fetch(apiBase + urlPath);
      const json = await res.json();
      assert.equal(res.status, 200, urlPath);
      return json;
    }
    const all = await get('/api/prospects');
    const tierA = await get('/api/prospects?tier=A');
    const focus = await get(`/api/focus?today=${TODAY}`);
    const stats = await get('/api/prospects/stats');
    const one = await get(`/api/prospects/${archivedPest.id}`);
    const ids = (body) => new Set((body.prospects || []).map(row => row.id));

    assert.equal(ids(all).has(archivedPest.id), false);
    assert.equal(ids(all).has(archivedBenign.id), false);
    assert.equal(ids(all).has(twin.id), true);
    assert.equal(ids(all).has(livePest.id), true);
    assert.equal(ids(tierA).has(livePest.id), false);
    assert.equal(ids(tierA).has(twin.id), true);
    assert.equal(ids(tierA).has(archivedPest.id), false);
    assert.equal(one.archive_reason, PEST_ARCHIVE_REASON);
    assert.equal(one.fit_score, 1);
    assert.equal(String(one.company).includes('@'), false);

    assert.equal(focus.followups_due.some(row => row.id === twin.id), true);
    assert.equal(focus.followups_due.some(row => row.id === archivedPest.id), false);
    assert.equal(focus.followups_due.some(row => row.id === archivedBenign.id), false);
    assert.equal(focus.top_new_leads.some(row => row.id === twin.id), true);
    assert.equal(focus.top_new_leads.some(row => row.id === livePest.id), false);
    assert.equal(focus.top_new_leads.some(row => row.id === archivedPest.id), false);
    assert.equal(focus.gone_quiet.some(row => row.id === activeQuiet.id), true);
    assert.equal(focus.gone_quiet.some(row => row.id === archivedQuiet.id), false);
    assert.equal(focus.counts.open_leads, 4);
    assert.equal(focus.counts.a_tier_open, 3);
    assert.equal(focus.counts.hot, 1);
    assert.equal(focus.counts.pipeline_value, 5);
    assert.equal(focus.counts.new_24h, 4);
    assert.equal(stats.stages.found.count, 2);
    assert.equal(stats.stages.qualified.count, 1);

    const picked = await pickLeads(50);
    assert.deepEqual(picked.map(row => row.id), [twin.id]);
    const summary = await get('/api/proposals/summary');
    assert.equal(summary.eligible_leads, 1);

    await assert.rejects(() => draftProposal(archivedBenign.id), (err) => {
      assert.equal(err.status, 409);
      assert.equal(err.message, `${ARCHIVED_LEAD_REASON}.`);
      assert.equal(err.message.includes('@'), false);
      return true;
    });
    assert.equal(claudeCalls, 0);

    const drafted = await fetch(apiBase + '/api/proposals', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prospect_id: archivedBenign.id }),
    });
    const draftedBody = await drafted.json();
    assert.equal(drafted.status, 409);
    assert.equal(draftedBody.error, `${ARCHIVED_LEAD_REASON}.`);
    const jobs = await pool.query('SELECT COUNT(*)::int AS n FROM proposal_jobs');
    assert.equal(jobs.rows[0].n, 0);

    async function insertProposal(prospectId, slug, status) {
      const { rows } = await pool.query(
        `INSERT INTO proposals (
           prospect_id, version, status, slug, to_email, to_name, subject, body, followup1
         ) VALUES ($1, 1, $2, $3, $4, 'Dana', 'A note', 'Hello from the draft.', 'Checking back.')
         RETURNING id`,
        [prospectId, status, slug, `test+${slug}@example.com`]
      );
      return rows[0].id;
    }
    const draftId = await insertProposal(archivedBenign.id, 'arch-draft', 'draft');
    const discardedId = await insertProposal(archivedBenign.id, 'arch-discarded', 'discarded');

    const sentMail = [];
    _setTransport({
      async sendMail(mail) {
        sentMail.push(mail);
        return { messageId: '<archive@localhost>', threadId: 'thr-archive' };
      },
    });
    await assert.rejects(() => approveAndSend(draftId), (err) => {
      assert.equal(err.status, 409);
      assert.equal(err.message, `${ARCHIVED_LEAD_REASON}.`);
      return true;
    });
    assert.equal(sentMail.length, 0);

    const marked = await fetch(apiBase + `/api/proposals/${draftId}/mark-sent`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ note: 'manual' }),
    });
    const markedBody = await marked.json();
    assert.equal(marked.status, 409);
    assert.equal(markedBody.error, `${ARCHIVED_LEAD_REASON}.`);
    const draftStatus = await pool.query('SELECT status FROM proposals WHERE id = $1', [draftId]);
    assert.equal(draftStatus.rows[0].status, 'draft');
    const benignStage = await pool.query('SELECT stage FROM prospects WHERE id = $1', [archivedBenign.id]);
    assert.equal(benignStage.rows[0].stage, 'contacted');

    const restored = await fetch(apiBase + `/api/proposals/${discardedId}/restore`, { method: 'POST' });
    const restoredBody = await restored.json();
    assert.equal(restored.status, 409);
    assert.equal(restoredBody.error, `${ARCHIVED_LEAD_REASON}.`);
    const discardedStatus = await pool.query('SELECT status FROM proposals WHERE id = $1', [discardedId]);
    assert.equal(discardedStatus.rows[0].status, 'discarded');

    const keeper = await insertProspect({
      google_place_id: 'test-place-follow-keeper',
      company: 'TEST: Keeper Heating',
      industry: 'HVAC',
      email: 'test+keeper@example.com',
      website: null,
      stage: 'found',
    });
    const heldIds = [];
    for (let i = 0; i < 25; i++) {
      const held = await insertProspect({
        google_place_id: `test-place-follow-held-${i}`,
        company: `TEST: Held Heating ${i}`,
        industry: 'HVAC',
        email: `test+held${i}@example.com`,
        website: null,
        phone: null,
        stage: 'found',
      });
      heldIds.push(held.id);
    }
    await pool.query(
      `UPDATE prospects SET archived_at = NOW(), archive_reason = 'manual hold' WHERE id = ANY($1::int[])`,
      [heldIds]
    );
    async function dueProposal(prospectId, slug, sentSql) {
      await pool.query(
        `INSERT INTO proposals (
           prospect_id, version, status, slug, to_email, to_name, subject, body, followup1,
           sent_at, followup1_due_at
         ) VALUES (
           $1, 1, 'sent', $2, $3, 'Dana', 'A note', 'Hello from the draft.', 'Checking back.',
           ${sentSql}, NOW() - INTERVAL '1 hour'
         )`,
        [prospectId, slug, `test+${slug}@example.com`]
      );
    }
    await dueProposal(keeper.id, 'follow-keeper', "NOW() - INTERVAL '1 day'");
    for (let i = 0; i < heldIds.length; i++) {
      await dueProposal(heldIds[i], `follow-held-${i}`, "NOW() - INTERVAL '2 days'");
    }
    const follow = await sendDueFollowups();
    assert.equal(follow.sent, 1);
    assert.equal(sentMail.length, 1);
    assert.equal(sentMail[0].to.address, 'test+follow-keeper@example.com');
    const heldSent = await pool.query(
      `SELECT COUNT(*)::int AS n FROM proposals
        WHERE prospect_id = ANY($1::int[]) AND followup1_sent_at IS NOT NULL`,
      [heldIds]
    );
    assert.equal(heldSent.rows[0].n, 0);
  });

  it('does not revive or rescore an archived lead during discovery', async () => {
    await resetDb();
    assert.equal(INDUSTRIES.length, 6);
    const archived = await insertProspect({
      google_place_id: 'test-place-archived-discovery',
      company: 'TEST: Kept Heating',
      industry: 'HVAC',
      email: 'test+kept-discovery@example.com',
      website: 'https://kept.example',
    });
    await pool.query(
      `UPDATE prospects
          SET archived_at = NOW(), archive_reason = $2, fit_score = 3, fit_tier = 'D'
        WHERE id = $1`,
      [archived.id, PEST_ARCHIVE_REASON]
    );
    const before = await stamp(archived.id);
    _setSearch(async () => [
      {
        id: 'test-place-archived-discovery',
        displayName: { text: 'TEST: Renamed Heating' },
        formattedAddress: '100 Center St, Provo, UT 84601',
        nationalPhoneNumber: '(801) 555-0199',
        websiteUri: 'https://renamed.example',
        rating: 4.0,
        userRatingCount: 80,
        businessStatus: 'OPERATIONAL',
        addressComponents: [
          { types: ['locality'], longText: 'Provo', shortText: 'Provo' },
          { types: ['administrative_area_level_1'], longText: 'Utah', shortText: 'UT' },
          { types: ['postal_code'], longText: '84601', shortText: '84601' },
        ],
      },
      {
        id: 'test-place-discovery-new',
        displayName: { text: 'TEST: New Heating' },
        formattedAddress: '200 Center St, Provo, UT 84601',
        nationalPhoneNumber: '(801) 555-0102',
        websiteUri: 'https://new-heating.example',
        rating: 4.0,
        userRatingCount: 80,
        businessStatus: 'OPERATIONAL',
        addressComponents: [
          { types: ['locality'], longText: 'Provo', shortText: 'Provo' },
          { types: ['administrative_area_level_1'], longText: 'Utah', shortText: 'UT' },
          { types: ['postal_code'], longText: '84601', shortText: '84601' },
        ],
      },
    ]);
    try {
      const summary = await runDiscovery();
      assert.equal(summary.errors, 0);
      assert.equal(summary.queriesRun, 6);
      assert.equal(summary.newAdded, 1);
    } finally {
      _setSearch(null);
    }
    const after = await stamp(archived.id);
    assert.equal(after.company, before.company);
    assert.equal(after.email, before.email);
    assert.equal(after.fit_score, 3);
    assert.equal(after.fit_tier, 'D');
    assert.equal(after.archive_reason, PEST_ARCHIVE_REASON);
    assert.equal(new Date(after.archived_at).toISOString(), new Date(before.archived_at).toISOString());
    assert.equal(new Date(after.updated_at).toISOString(), new Date(before.updated_at).toISOString());
    const rows = await pool.query('SELECT COUNT(*)::int AS n FROM prospects');
    assert.equal(rows.rows[0].n, 2);
    const created = await pool.query(
      `SELECT fit_score, fit_tier, archived_at FROM prospects WHERE google_place_id = 'test-place-discovery-new'`
    );
    assert.equal(created.rows[0].fit_score, 100);
    assert.equal(created.rows[0].fit_tier, 'A');
    assert.equal(created.rows[0].archived_at, null);
  });
});
