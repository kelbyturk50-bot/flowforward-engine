process.env.CRM_API_KEY = 'test-rebuild-errors-key-32chars!!';

require('./preload');

// Operator-facing draft errors keep their sentence. An error with no status
// stays the generic 500, including a database fault. Job rows still store
// the original message.
const http = require('http');
const express = require('express');
const { describe, it, before, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const { APIConnectionError, APIConnectionTimeoutError } = require('@anthropic-ai/sdk');
const draft = require('../src/proposals/draft');
const cfg = require('../src/proposals/config');
const { applySchema } = require('../src/db/migrate');
const { resetDb, insertProspect, closePool, pool, FAKE_PROPOSAL } = require('./fixtures');

const API_KEY = process.env.CRM_API_KEY;
const CAP = `Stopped: cost passed the $${cfg.MAX_COST_PER_LEAD} per-lead cap.`;
const NEVER = 'Claude did not submit a proposal after several turns.';
const NO_KEY = 'ANTHROPIC_API_KEY is not set in Railway Variables.';
const UNREACHABLE = 'Couldn\'t reach Claude. Try again.';
const GENERIC = 'Something went wrong.';
const PG_TEXT = /duplicate key|proposals_pkey|violates/;

let server;
let apiBase;
let place = 0;

function capClient() {
  return {
    messages: { async create() {
      return { stop_reason: 'end_turn', usage: { input_tokens: 10, output_tokens: 200000 }, content: [] };
    } },
  };
}

function silentClient() {
  const calls = [];
  return {
    calls,
    messages: { async create() {
      calls.push(1);
      return { stop_reason: 'end_turn', usage: { input_tokens: 10, output_tokens: 10 }, content: [{ type: 'text', text: 'working' }] };
    } },
  };
}

function throwingClient(err) {
  return { messages: { async create() { throw err; } } };
}

function captureErrors() {
  const lines = [];
  const orig = console.error;
  console.error = (...args) => { lines.push(args.map(String).join(' ')); };
  return { lines, restore() { console.error = orig; } };
}

async function proposalRow(status) {
  place += 1;
  const prospect = await insertProspect({
    website: null,
    email: `test+rebuild${place}@example.com`,
    google_place_id: `test-place-rebuild-err-${place}`,
  });
  const { rows } = await pool.query(
    `INSERT INTO proposals (prospect_id, version, status, slug, research, subject, body, onepager)
     VALUES ($1, 1, $2, $3, '{}'::jsonb, 'subj', 'the email', $4) RETURNING id`,
    [prospect.id, status, `rebuild-err-${place}`, JSON.stringify({
      headline: 'A few ideas', intro: '', observations: [], opportunities: [], closing: '',
    })]
  );
  return { prospect, id: rows[0].id };
}

async function post(path, body) {
  const res = await fetch(`${apiBase}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': API_KEY },
    body: JSON.stringify(body || {}),
  });
  const json = await res.json();
  return { status: res.status, json };
}

async function waitJob(id) {
  const deadline = Date.now() + 5000;
  let row;
  while (Date.now() < deadline) {
    const q = await pool.query('SELECT status, error FROM proposal_jobs WHERE id = $1', [id]);
    row = q.rows[0];
    if (row && (row.status === 'failed' || row.status === 'done')) return row;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return row;
}

describe('rebuild-onepager operator errors', { concurrency: false }, () => {
  before(async () => {
    await applySchema();
    const app = express();
    app.use(express.json());
    app.use('/api', require('../src/api/auth'));
    app.use('/api/proposals', require('../src/api/proposals'));
    server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    apiBase = `http://127.0.0.1:${server.address().port}`;
  });

  beforeEach(async () => {
    delete process.env.ANTHROPIC_API_KEY;
    draft._setClient(null);
    await resetDb();
  });

  after(async () => {
    delete process.env.ANTHROPIC_API_KEY;
    draft._setClient(null);
    if (server) await new Promise((resolve) => server.close(resolve));
    await closePool();
  });

  it('rebuild cost cap returns 409 with the cap sentence', async () => {
    draft._setClient(capClient());
    const { id } = await proposalRow('sent');
    const res = await post(`/api/proposals/${id}/rebuild-onepager`);
    assert.equal(res.status, 409);
    assert.equal(res.json.error, CAP);
    console.log(`[rebuild] cost cap → ${res.status} ${res.json.error}`);
  });

  it('rebuild returns 502 when Claude never submits', async () => {
    const client = silentClient();
    draft._setClient(client);
    const { id } = await proposalRow('sent');
    const res = await post(`/api/proposals/${id}/rebuild-onepager`);
    assert.equal(client.calls.length, 6);
    assert.equal(res.status, 502);
    assert.equal(res.json.error, NEVER);
    console.log(`[rebuild] no submit → ${res.status} ${res.json.error}`);
  });

  it('rebuild returns 400 when the API key is unset', async () => {
    draft._setClient(null);
    assert.equal(process.env.ANTHROPIC_API_KEY, undefined);
    const { id } = await proposalRow('sent');
    const res = await post(`/api/proposals/${id}/rebuild-onepager`);
    assert.equal(res.status, 400);
    assert.equal(res.json.error, NO_KEY);
    console.log(`[rebuild] missing key → ${res.status} ${res.json.error}`);
  });

  it('rebuild returns 502 with a plain message on APIConnectionError', async () => {
    draft._setClient(throwingClient(new APIConnectionError({
      message: 'connect ECONNREFUSED api.anthropic.com sk-ant-secret',
    })));
    const { id } = await proposalRow('sent');
    const logs = captureErrors();
    try {
      const res = await post(`/api/proposals/${id}/rebuild-onepager`);
      assert.equal(res.status, 502);
      assert.equal(res.json.error, UNREACHABLE);
      const body = JSON.stringify(res.json);
      assert.doesNotMatch(body, /sk-ant|api\.anthropic|Connection error/);
      const logged = logs.lines.join('\n');
      assert.match(logged, /rebuild connection failed/);
      assert.doesNotMatch(logged, /sk-ant|api\.anthropic|ECONNREFUSED/);
      console.log(`[rebuild] connection error → ${res.status} ${res.json.error}`);
    } finally {
      logs.restore();
    }
  });

  it('rebuild returns 502 with a plain message on APIConnectionTimeoutError', async () => {
    draft._setClient(throwingClient(new APIConnectionTimeoutError({
      message: 'Request timed out. sk-ant-secret',
    })));
    const { id } = await proposalRow('sent');
    const logs = captureErrors();
    try {
      const res = await post(`/api/proposals/${id}/rebuild-onepager`);
      assert.equal(res.status, 502);
      assert.equal(res.json.error, UNREACHABLE);
      const body = JSON.stringify(res.json);
      assert.doesNotMatch(body, /sk-ant|timed out|api\.anthropic/);
      assert.doesNotMatch(logs.lines.join('\n'), /sk-ant|timed out/);
      console.log(`[rebuild] connection timeout → ${res.status} ${res.json.error}`);
    } finally {
      logs.restore();
    }
  });

  it('rebuild DB fault returns Something went wrong with no Postgres text', async () => {
    draft._setClient({
      messages: { async create() {
        return {
          stop_reason: 'tool_use',
          usage: { input_tokens: 10, output_tokens: 10 },
          content: [{ type: 'tool_use', id: 't1', name: 'submit_proposal', input: FAKE_PROPOSAL }],
        };
      } },
    });
    const { id } = await proposalRow('sent');
    const before = await pool.query('SELECT onepager FROM proposals WHERE id = $1', [id]);
    const original = pool.query.bind(pool);
    pool.query = async function patched(sql, params) {
      const text = typeof sql === 'string' ? sql : (sql && sql.text) || '';
      if (/SET onepager/i.test(text)) {
        const err = new Error('duplicate key value violates unique constraint "proposals_pkey"');
        err.code = '23505';
        throw err;
      }
      return original(sql, params);
    };
    const logs = captureErrors();
    try {
      const res = await post(`/api/proposals/${id}/rebuild-onepager`);
      assert.equal(res.status, 500);
      assert.equal(res.json.error, GENERIC);
      assert.equal(Object.keys(res.json).join(','), 'error');
      assert.doesNotMatch(JSON.stringify(res.json), PG_TEXT);
      assert.doesNotMatch(logs.lines.join('\n'), PG_TEXT);
      assert.match(logs.lines.join('\n'), /\[api\] 23505/);
    } finally {
      logs.restore();
      pool.query = original;
    }
    const after = await pool.query('SELECT onepager FROM proposals WHERE id = $1', [id]);
    assert.deepEqual(after.rows[0].onepager, before.rows[0].onepager);
    console.log('[rebuild] database fault → 500 Something went wrong. (no Postgres text)');
  });

  it('a failed draft job stores the cap sentence', async () => {
    process.env.ANTHROPIC_API_KEY = 'test-not-a-real-key';
    draft._setClient(capClient());
    try {
      const { id, prospect } = await proposalRow('draft');
      const res = await post(`/api/proposals/${id}/regenerate`);
      assert.equal(res.status, 202);
      const row = await waitJob(res.json.job.id);
      assert.equal(row.status, 'failed');
      assert.equal(row.error, CAP);
      assert.doesNotMatch(row.error, /Something went wrong/);
      const still = await pool.query('SELECT status FROM proposals WHERE id = $1', [id]);
      assert.equal(still.rows[0].status, 'draft');
      assert.equal(prospect.id, res.json.job.prospect_id);
      console.log(`[rebuild] job error stored: ${row.error}`);
    } finally {
      delete process.env.ANTHROPIC_API_KEY;
    }
  });

  it('a nightly batch stores the cap sentence on the run log', async () => {
    draft._setClient(capClient());
    place += 1;
    const prospect = await insertProspect({
      website: null,
      email: `test+nightly${place}@example.com`,
      google_place_id: `test-place-rebuild-nightly-${place}`,
    });
    await pool.query(`UPDATE prospects SET fit_tier = 'A', fit_score = 90, stage = 'found' WHERE id = $1`, [prospect.id]);
    const result = await draft.runProposalBatch({ trigger: 'manual', count: 1 });
    assert.equal(result.errors, 1);
    assert.equal(result.drafted, 0);
    assert.equal(result.log[0].error, CAP);
    const stored = await pool.query('SELECT status, log FROM proposal_runs WHERE id = $1', [result.run_id]);
    assert.equal(stored.rows[0].status, 'done_with_errors');
    assert.equal(stored.rows[0].log[0].error, CAP);
    assert.doesNotMatch(stored.rows[0].log[0].error, /Something went wrong/);
    console.log(`[rebuild] nightly log stored: ${stored.rows[0].log[0].error}`);
  });
});
