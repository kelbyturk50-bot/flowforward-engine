// Rows and a fake Claude client for the smoke tests. Nothing here calls a network.

const pool = require('../src/db/client');
const { BRAND_FIXTURES } = require('../src/brand/fixtures');

const HVAC_LEAD = {
  google_place_id: 'test-place-wasatch-heating',
  company: 'Wasatch Heating',
  industry: 'HVAC',
  phone: '(801) 555-0100',
  website: 'https://wasatchheating.example',
  address: '100 Center St, Provo, UT 84601',
  city: 'Provo',
  state: 'UT',
  zip: '84601',
  rating: 4.0,
  review_count: 80,
  score: 8,
  source: 'google_places',
  stage: 'found',
};

async function resetDb() {
  await pool.query(`
    TRUNCATE TABLE
      chat_demo_leads,
      chat_demo_events,
      chat_demo_reservations,
      chat_demo_turns,
      chat_demo_sessions,
      chat_demo_links,
      chat_demo_link_days,
      chat_demo_global_days,
      chat_demo_ip_hours,
      chat_demo_ip_days,
      chat_demo_rate_minutes,
      chat_demo_spend_days,
      prototype_facts,
      inbox_items,
      inbox_messages,
      prototypes,
      pilot_estimate_suppressions,
      pilot_open_estimates,
      pilot_customers,
      pilot_events,
      pilot_tokens,
      proposal_jobs,
      proposal_runs,
      proposals,
      prospect_activities,
      prospect_brands,
      tasks,
      projects,
      discovery_runs,
      campaign_touches,
      campaign_leads,
      campaign_variants,
      campaigns,
      prospects,
      app_settings
    RESTART IDENTITY CASCADE
  `);
}

async function insertProspect(overrides = {}) {
  const row = { ...HVAC_LEAD, ...overrides };
  const { rows } = await pool.query(
    `INSERT INTO prospects
       (google_place_id, company, industry, phone, website, address, city, state, zip,
        rating, review_count, score, source, stage, email, contact_name, fsm_detected)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
     RETURNING *`,
    [
      row.google_place_id, row.company, row.industry, row.phone, row.website, row.address,
      row.city, row.state, row.zip, row.rating, row.review_count, row.score, row.source, row.stage,
      row.email || null, row.contact_name || null,
      row.fsm_detected === undefined ? null : row.fsm_detected,
    ]
  );
  return rows[0];
}

const FAKE_PROPOSAL = {
  analysis: {
    snapshot: 'Owner-operated HVAC shop in Provo. The owner still answers the phone.',
    owner_name: 'Dana Reyes',
    owner_role: 'Owner',
    owner_source: 'test fixture',
    best_email: 'dana@wasatchheating.test',
    email_source: 'test fixture',
    other_contacts: [],
    tools_in_use: [],
    strengths: ['Steady review volume'],
    pain_signals: [{ signal: 'Missed after-hours calls', evidence: 'Fixture, not a live review', source: 'test' }],
    fit_verdict: 'good',
    fit_reason: 'Busy owner, reachable, in market.',
    confidence: 4,
    talking_points: ['Who answers the phone after 5?'],
    verify: [],
  },
  email: {
    to_name: 'Dana',
    subject: 'Quick idea for Wasatch Heating',
    body: 'Hi Dana,\n\nI put a few notes here: {{ONEPAGER_URL}}\n',
    followup1: 'Bumping this in case it got buried.',
    followup2: 'Last note from me.',
  },
  onepager: {
    headline: 'A few ideas for Wasatch Heating',
    intro: 'Notes from a first look.',
    observations: [{ title: 'After-hours calls', detail: 'Nobody is covering the phone.' }],
    opportunities: [{
      title: 'After-hours answering',
      problem: 'Missed calls',
      solution: 'An AI receptionist that books or triages.',
      impact: 'A few recovered jobs a month.',
    }],
    closing: 'Worth a 15-minute look.',
  },
};

function fakeClaude() {
  return {
    messages: {
      async create() {
        return {
          stop_reason: 'end_turn',
          usage: { input_tokens: 120, output_tokens: 80 },
          content: [{ type: 'tool_use', id: 'toolu_test', name: 'submit_proposal', input: FAKE_PROPOSAL }],
        };
      },
    },
  };
}

async function seedBrandFixtures(db = pool) {
  for (const fixture of BRAND_FIXTURES) {
    await db.query(
      `INSERT INTO prospect_brands (name, logo_url, colors, source, test_tag)
       VALUES ($1, $2, $3::jsonb, $4, $5)
       ON CONFLICT (test_tag) DO NOTHING`,
      [fixture.name, fixture.logoUrl, JSON.stringify(fixture.colors), fixture.source, fixture.testTag]
    );
  }
}

async function closePool() {
  await pool.end();
}

module.exports = {
  pool, HVAC_LEAD, FAKE_PROPOSAL, resetDb, insertProspect, seedBrandFixtures, fakeClaude, closePool,
};
