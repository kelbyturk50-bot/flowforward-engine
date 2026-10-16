// Brand entry, v1. Static TEST fixtures and manual insert only.
// This router does not fetch a logo or resolve a hostname.

const express = require('express');
const router = express.Router();
const pool = require('../db/client');
const { BRAND_FIXTURES } = require('../brand/fixtures');
const { validateBrand } = require('../brand/validate');

function toPublic(row) {
  return {
    id: row.id,
    prospectId: row.prospect_id,
    name: row.name,
    logoUrl: row.logo_url,
    colors: row.colors,
    source: row.source,
    testTag: row.test_tag,
  };
}

router.get('/fixtures', (req, res) => {
  res.json({ brands: BRAND_FIXTURES });
});

router.get('/', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, prospect_id, name, logo_url, colors, source, test_tag
         FROM prospect_brands
        ORDER BY id`
    );
    res.json({ brands: rows.map(toPublic) });
  } catch (err) {
    console.error('[brands] list failed:', err.message);
    res.status(500).json({ error: 'server_error' });
  }
});

router.post('/', async (req, res) => {
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const parsed = validateBrand({
    name: body.name,
    logoUrl: body.logoUrl,
    colors: body.colors,
    testTag: body.testTag,
    prospectId: body.prospectId,
    source: 'manual',
  });
  if (!parsed.ok) {
    return res.status(400).json({ error: 'invalid_brand', field: parsed.field, message: parsed.message });
  }
  try {
    if (parsed.brand.prospectId != null) {
      const found = await pool.query('SELECT id, company FROM prospects WHERE id = $1', [parsed.brand.prospectId]);
      if (!found.rows[0]) return res.status(404).json({ error: 'not_found' });
      if (!String(found.rows[0].company || '').startsWith('TEST:')) {
        return res.status(400).json({
          error: 'invalid_brand',
          field: 'prospectId',
          message: 'prospect company must start with TEST:',
        });
      }
    }
    const { rows } = await pool.query(
      `INSERT INTO prospect_brands (prospect_id, name, logo_url, colors, source, test_tag)
       VALUES ($1, $2, $3, $4::jsonb, 'manual', $5)
       RETURNING id, prospect_id, name, logo_url, colors, source, test_tag`,
      [
        parsed.brand.prospectId,
        parsed.brand.name,
        parsed.brand.logoUrl,
        JSON.stringify(parsed.brand.colors),
        parsed.brand.testTag,
      ]
    );
    res.status(201).json(toPublic(rows[0]));
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'duplicate_test_tag' });
    if (err.code === '23514') return res.status(400).json({ error: 'invalid_brand', message: 'rejected by schema' });
    console.error('[brands] insert failed:', err.message);
    res.status(500).json({ error: 'server_error' });
  }
});

router.get('/:id', async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id < 1) return res.status(400).json({ error: 'bad_request' });
  try {
    const { rows } = await pool.query(
      `SELECT id, prospect_id, name, logo_url, colors, source, test_tag
         FROM prospect_brands WHERE id = $1`,
      [id]
    );
    if (!rows[0]) return res.status(404).json({ error: 'not_found' });
    res.json(toPublic(rows[0]));
  } catch (err) {
    console.error('[brands] read failed:', err.message);
    res.status(500).json({ error: 'server_error' });
  }
});

module.exports = router;
