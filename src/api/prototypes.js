// Revoke an active prototype. API key required (mounted under /api).
// Does not send mail.

const express = require('express');
const router = express.Router();
const { revoke } = require('../prototypes/store');

function prototypeId(req) {
  const raw = String(req.params.id || '');
  if (!/^\d+$/.test(raw)) return null;
  const id = Number(raw);
  return Number.isInteger(id) && id > 0 ? id : null;
}

router.post('/:id/revoke', async (req, res) => {
  const id = prototypeId(req);
  if (!id) return res.status(404).json({ error: 'not_found' });
  try {
    const row = await revoke(id);
    if (!row) return res.status(404).json({ error: 'not_found' });
    res.set('Cache-Control', 'no-store');
    res.json({
      id: row.id,
      revoked_at: new Date(row.revoked_at).toISOString(),
    });
  } catch (err) {
    console.error('[prototype] revoke failed:', err.message);
    res.status(500).json({ error: 'Something went wrong.' });
  }
});

module.exports = router;
