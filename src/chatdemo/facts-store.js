// CRM facts sheet. Writes are TEST: prospects only. cached_research reads the
// prospect row that is already stored. This module does not fetch.

const { codePointLength, perGoogle } = require('./copy');
const pool = require('../db/client');

const FIELDS = new Set([
  'business_name', 'services', 'service_area', 'phone', 'address', 'hours',
  'emergency_247', 'financing', 'free_estimate', 'maintenance_plan', 'price',
  'license', 'license_number', 'insurance', 'bonding', 'warranty', 'guarantee',
  'years_in_business', 'time_zone',
]);

const YES_FIELDS = new Set([
  'free_estimate', 'emergency_247', 'financing', 'maintenance_plan',
  'license', 'insurance', 'bonding',
]);

const SOURCES = new Set(['manual', 'cached_research', 'fixture']);
const HOSTILE = /[\u0000-\u001F\u007F<>\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF]/;

function fail(error) {
  return { error };
}

function tagForCompany(company) {
  const rest = String(company || '').replace(/^TEST:\s*/, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  const tag = `TEST:${rest}`;
  if (!/^TEST:[a-z0-9]+(-[a-z0-9]+)*$/.test(tag) || tag.length > 80) return null;
  return tag;
}

function cleanText(value, max) {
  const text = String(value ?? '').normalize('NFKC');
  const chars = codePointLength(text);
  if (chars < 1 || chars > max) return null;
  if (HOSTILE.test(text)) return null;
  return text;
}

function validZone(value) {
  try {
    Intl.DateTimeFormat('en-US', { timeZone: value });
    return true;
  } catch (err) {
    return false;
  }
}

function validUrl(url) {
  if (url == null || url === '') return { ok: true, value: null };
  const value = String(url);
  if (value.length < 8 || value.length > 300) return { ok: false };
  if (!value.startsWith('https://')) return { ok: false };
  if (/:\/\/[^/?#]*@/.test(value)) return { ok: false };
  if (/[\s\u0000-\u001F\u007F]/.test(value)) return { ok: false };
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== 'https:') return { ok: false };
  } catch (err) {
    return { ok: false };
  }
  return { ok: true, value };
}

async function writeFact({ prospectId, field, value, source, sourceUrl, snippet, at }) {
  const id = Number(prospectId);
  if (!Number.isInteger(id) || id < 1) return fail('invalid_body');
  if (!FIELDS.has(field) || !SOURCES.has(source)) return fail('invalid_body');
  const { rows } = await pool.query(
    `SELECT company, research FROM prospects WHERE id = $1`,
    [id]
  );
  if (!rows[0]) return fail('not_found');
  if (!String(rows[0].company || '').startsWith('TEST:')) return fail('test_only');
  const tag = tagForCompany(rows[0].company);
  if (!tag) return fail('invalid_body');
  const stored = cleanText(value, 500);
  if (!stored) return fail('invalid_body');
  if (YES_FIELDS.has(field) && stored !== 'yes') return fail('invalid_body');
  if (field === 'time_zone' && !validZone(stored)) return fail('invalid_body');
  const url = validUrl(sourceUrl);
  if (!url.ok) return fail('invalid_body');
  let snippetText = null;
  if (snippet != null && snippet !== '') {
    snippetText = cleanText(snippet, 300);
    if (!snippetText) return fail('invalid_body');
  }
  if (source === 'cached_research') {
    if (rows[0].research == null) return fail('invalid_body');
    if (!url.value || !snippetText) return fail('invalid_body');
  }
  const captured = at instanceof Date ? at : new Date();
  const { rows: saved } = await pool.query(
    `INSERT INTO prototype_facts
       (prospect_id, field, value, source, source_url, snippet, captured_at, test_tag)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT (prospect_id, field) DO UPDATE
       SET value = EXCLUDED.value,
           source = EXCLUDED.source,
           source_url = EXCLUDED.source_url,
           snippet = EXCLUDED.snippet,
           captured_at = EXCLUDED.captured_at,
           test_tag = EXCLUDED.test_tag
     RETURNING field, value, source, source_url, snippet, captured_at, test_tag`,
    [id, field, stored, source, url.value, snippetText, captured, tag]
  );
  return { fact: saved[0] };
}

async function listFacts(prospectId) {
  const id = Number(prospectId);
  if (!Number.isInteger(id) || id < 1) return fail('invalid_body');
  const { rows: leads } = await pool.query(`SELECT id FROM prospects WHERE id = $1`, [id]);
  if (!leads[0]) return fail('not_found');
  const { rows } = await pool.query(
    `SELECT field, value, source, source_url, snippet, captured_at, test_tag
       FROM prototype_facts
      WHERE prospect_id = $1
      ORDER BY field`,
    [id]
  );
  return {
    facts: rows.map((row) => ({
      field: row.field,
      value: row.value,
      source: row.source,
      source_url: row.source_url,
      snippet: row.snippet,
      captured_at: row.captured_at,
      test_tag: row.test_tag,
      per_google: perGoogle(row),
    })),
  };
}

module.exports = { writeFact, listFacts, tagForCompany, FIELDS };
