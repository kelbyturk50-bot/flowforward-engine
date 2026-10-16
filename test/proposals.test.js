require('./preload');

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { draftProposal, _setClient } = require('../src/proposals/draft');
const { approveAndSend, _setTransport, mailMode } = require('../src/proposals/send');
const { resetDb, insertProspect, fakeClaude, closePool, pool, FAKE_PROPOSAL } = require('./fixtures');

describe('proposals', () => {
  let prospect;

  before(async () => {
    await resetDb();
    // No website and no Places key, so researchLead returns without HTTP.
    prospect = await insertProspect({
      google_place_id: 'test-place-draft-wasatch',
      website: null,
      email: null,
      contact_name: null,
    });
    _setClient(fakeClaude());
  });

  after(async () => {
    _setClient(null);
    _setTransport(null);
    await closePool();
  });

  it('drafts a proposal with the Anthropic mock', async () => {
    const proposal = await draftProposal(prospect.id);
    assert.equal(proposal.status, 'draft');
    assert.equal(proposal.version, 1);
    assert.equal(proposal.subject, FAKE_PROPOSAL.email.subject);
    assert.equal(proposal.to_email, 'dana@wasatchheating.test');
    assert.equal(proposal.to_name, 'Dana');
    assert.match(proposal.slug, /^wasatch-heating-[0-9a-f]{8}$/);
    assert.ok(Number(proposal.cost_usd) > 0);
    assert.equal(proposal.onepager.headline, FAKE_PROPOSAL.onepager.headline);
    assert.equal(proposal.analysis.owner_name, 'Dana Reyes');

    const lead = await pool.query('SELECT email, contact_name, stage FROM prospects WHERE id = $1', [prospect.id]);
    assert.equal(lead.rows[0].email, 'dana@wasatchheating.test');
    assert.equal(lead.rows[0].contact_name, 'Dana Reyes');
    assert.equal(lead.rows[0].stage, 'found');

    const notes = await pool.query(
      "SELECT body FROM prospect_activities WHERE prospect_id = $1 AND type = 'note'",
      [prospect.id]
    );
    assert.match(notes.rows[0].body, /Proposal v1 drafted/);
  });

  it('sends the draft through the test transport and does not open a Gmail connection', async () => {
    const sent = [];
    _setTransport({
      async sendMail(mail) {
        sent.push(mail);
        return { messageId: '<msg-test@localhost>', threadId: 'thr-test' };
      },
    });
    assert.equal(await mailMode(), 'test');

    const { rows } = await pool.query(
      "SELECT id FROM proposals WHERE prospect_id = $1 AND status = 'draft'",
      [prospect.id]
    );
    assert.equal(rows.length, 1);
    const updated = await approveAndSend(rows[0].id);

    assert.equal(updated.status, 'sent');
    assert.equal(updated.message_id, '<msg-test@localhost>');
    assert.equal(updated.thread_id, 'thr-test');
    assert.ok(updated.sent_at);
    assert.ok(updated.followup1_due_at);
    assert.ok(updated.followup2_due_at);

    assert.equal(sent.length, 1);
    assert.equal(sent[0].subject, 'Quick idea for Wasatch Heating');
    assert.equal(sent[0].to.address, 'dana@wasatchheating.test');
    assert.equal(sent[0].to.name, 'Dana');
    assert.match(sent[0].text, /http:\/\/127\.0\.0\.1:3000\/p\/wasatch-heating-/);
    assert.match(sent[0].text, /1 Test Street, Saratoga Springs, UT 84045/);
    assert.match(sent[0].text, /no thanks/i);

    const lead = await pool.query('SELECT stage, last_contacted_at FROM prospects WHERE id = $1', [prospect.id]);
    assert.equal(lead.rows[0].stage, 'contacted');
    assert.ok(lead.rows[0].last_contacted_at);

    const activity = await pool.query(
      "SELECT body FROM prospect_activities WHERE prospect_id = $1 AND type = 'email'",
      [prospect.id]
    );
    assert.match(activity.rows[0].body, /Sent proposal v1 to dana@wasatchheating\.test/);
  });
});
