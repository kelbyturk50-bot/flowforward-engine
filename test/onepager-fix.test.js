require('./preload');

// One-pagers that came back empty: stringified fields, retry, and rebuild.
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const draft = require('../src/proposals/draft');
const { renderPage } = require('../src/proposals/onepager');
const { resetDb, insertProspect, FAKE_PROPOSAL, closePool, pool } = require('./fixtures');

function client(sequence) {
  const calls = [];
  return {
    calls,
    messages: { async create(req) {
      calls.push(req);
      const input = sequence[Math.min(calls.length - 1, sequence.length - 1)];
      return { stop_reason: 'tool_use', usage: { input_tokens: 100, output_tokens: 50 }, content: [{ type: 'tool_use', id: `t${calls.length}`, name: 'submit_proposal', input }] };
    } },
  };
}

describe('empty one-pager fixes', () => {
  before(async () => { await resetDb(); });
  after(async () => { draft._setClient(null); await closePool(); });

  it('parses a one-pager the model sent as a JSON string', () => {
    const raw = { ...FAKE_PROPOSAL, onepager: JSON.stringify(FAKE_PROPOSAL.onepager) };
    assert.ok(draft.submissionProblem({ ...FAKE_PROPOSAL, onepager: 'nope' }));
    assert.equal(draft.submissionProblem(raw), null);
    const out = draft.normalizeSubmission(raw);
    assert.equal(typeof out.onepager, 'object');
    assert.ok(out.onepager.observations.length > 0);
  });

  it('asks Claude again when the one-pager comes back empty, and keeps the full one', async () => {
    const empty = { ...FAKE_PROPOSAL, onepager: { headline: '', intro: '', observations: [], opportunities: [], closing: '' } };
    const c = client([empty, FAKE_PROPOSAL]);
    draft._setClient(c);
    const p = await insertProspect({ website: null, google_place_id: 'test-place-onepager-retry' });
    const proposal = await draft.draftProposal(p.id);
    assert.equal(c.calls.length, 2);
    const last = c.calls[1].messages.at(-1).content[0];
    assert.equal(last.is_error, true);
    assert.match(last.content, /one-pager is incomplete/);
    assert.ok(proposal.onepager.observations.length > 0);
    assert.ok(proposal.onepager.opportunities.length > 0);
    console.log(`[onepager] empty first submit retried; saved ${proposal.onepager.observations.length} observations, ${proposal.onepager.opportunities.length} opportunities`);
  });

  it('rebuilds just the one-pager of a sent proposal, keeping its slug and email', async () => {
    draft._setClient(client([FAKE_PROPOSAL]));
    const p = await insertProspect({ website: null, google_place_id: 'test-place-onepager-rebuild' });
    const { rows } = await pool.query(
      `INSERT INTO proposals (prospect_id, version, status, slug, research, subject, body, onepager, sent_at)
       VALUES ($1, 1, 'sent', 'rebuild-slug-1', '{}'::jsonb, 'subj', 'the email', $2, NOW()) RETURNING id`,
      [p.id, { headline: 'A few ideas', intro: '', observations: [], opportunities: [], closing: '' }]);
    const before = renderPage({ onepager: { headline: 'A few ideas', observations: [], opportunities: [] } }, { company: 'x' });
    assert.equal(before.includes('What I noticed'), false);
    const updated = await draft.rebuildOnepager(rows[0].id);
    assert.equal(updated.slug, 'rebuild-slug-1');
    assert.equal(updated.body, 'the email');
    assert.equal(updated.status, 'sent');
    assert.ok(updated.onepager.observations.length > 0);
    const html = renderPage(updated, { company: 'x' }, { prototypeHref: 'https://api.test/demo/prototype/x' });
    assert.ok(html.indexOf('data-prototype-link') < html.indexOf('What I noticed'), 'prototype card sits above the rest');
    assert.ok(html.includes('Where I think I can help'));
    console.log('[onepager] sent proposal rebuilt in place; prototype card first, full sections after');
  });
});
