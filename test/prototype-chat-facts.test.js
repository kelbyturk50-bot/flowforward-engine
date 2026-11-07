process.env.CRM_API_KEY = 'test-prototype-chat-facts-key-32chars!';
delete process.env.FF_PROTOTYPE_ON_DRAFT;

require('./preload');

// A new prototype link proposes chat facts from research the proposal bot
// already saved. Disposable Postgres only; nothing is fetched.

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const store = require('../src/prototypes/store');
const { resetDb, insertProspect, closePool, pool } = require('./fixtures');

const RESEARCH = {
  business: { company: 'Timpview Plumbing', phone: '(801) 555-0144', address: '5 Center St, Orem, UT' },
  google: { maps_url: 'https://maps.google.com/?cid=99', hours: ['Monday: 8:00 AM – 5:00 PM'] },
  site: { pages: [{ url: 'https://timpview.example/', text: 'Drain Cleaning and Water Heaters in Orem and Provo. Free estimates.' }] },
};

describe('prototype create proposes chat facts', () => {
  before(async () => { await resetDb(); });
  after(async () => { await closePool(); });

  it('proposes facts from saved research and leaves them for review', async () => {
    const lead = await insertProspect({
      company: 'Timpview Plumbing', industry: 'Plumbing', city: 'Orem', state: 'UT',
      google_place_id: 'test-place-chat-facts-1', website: null, email: 'test+timpview@sample.test',
    });
    await pool.query(
      `INSERT INTO proposals (prospect_id, version, status, slug, research) VALUES ($1, 1, 'draft', 'test-chat-facts-1', $2::jsonb)`,
      [lead.id, JSON.stringify(RESEARCH)]
    );
    const row = await store.ensurePrototype(lead.id);
    assert.ok(row && row.id);
    const { rows } = await pool.query(
      `SELECT field, value, review_status, test_tag FROM prototype_facts WHERE prospect_id = $1 ORDER BY field`,
      [lead.id]
    );
    assert.deepEqual(rows.map((r) => r.field), ['address', 'free_estimate', 'hours', 'phone', 'service_area', 'services']);
    assert.ok(rows.every((r) => r.review_status === 'proposed' && r.test_tag === 'demo-prototype'));
    assert.equal(rows.find((r) => r.field === 'services').value, 'Drain Cleaning, Water Heaters');
  });

  it('a lead with no saved research still gets its prototype', async () => {
    const lead = await insertProspect({
      company: 'Bare Lead Heating', industry: 'HVAC', city: 'Lehi', state: 'UT',
      google_place_id: 'test-place-chat-facts-2', website: null, email: 'test+bare@sample.test',
    });
    const row = await store.ensurePrototype(lead.id);
    assert.ok(row && row.id);
    const { rows } = await pool.query(`SELECT COUNT(*)::int AS n FROM prototype_facts WHERE prospect_id = $1`, [lead.id]);
    assert.equal(rows[0].n, 0);
  });
});
