// GET/PUT /api/flags. Does not send mail.
// requireFlagApiKey is mounted in server.js before the shared /api guard.
// It trims CRM_API_KEY and applies only to these two methods. Other /api
// routes keep requireApiKey. Env-only flags are refused by the PUT handler.

const express = require('express');
const { isKnown, isWritable } = require('../flags/registry');
const { listFlags, setFlag } = require('../flags/resolve');

const MIN_FLAG_API_KEY_LENGTH = 32;

function flagApiKeyConfigured() {
  const raw = process.env.CRM_API_KEY;
  if (typeof raw !== 'string') return false;
  return raw.trim().length >= MIN_FLAG_API_KEY_LENGTH;
}

function requireFlagApiKey(req, res, next) {
  if (req.method !== 'GET' && req.method !== 'PUT') return next();
  if (flagApiKeyConfigured()) return next();
  console.log('[flags] refused; api key not configured');
  return res.status(503).json({ error: 'api_key_not_configured' });
}

const router = express.Router();

router.use(requireFlagApiKey);

router.get('/', async (req, res) => {
  const flags = await listFlags();
  res.json({ flags });
});

router.put('/:name', async (req, res) => {
  const name = req.params.name;
  if (!isKnown(name)) return res.status(400).json({ error: 'unknown_flag' });
  if (!isWritable(name)) return res.status(400).json({ error: 'flag_not_writable' });
  const body = req.body;
  if (!body || typeof body !== 'object' || Array.isArray(body) || typeof body.enabled !== 'boolean') {
    return res.status(400).json({ error: 'invalid_body' });
  }
  try {
    const flag = await setFlag(name, body.enabled);
    if (!flag) return res.status(400).json({ error: 'unknown_flag' });
    console.log(`[flags] ${flag.name} stored enabled=${flag.enabled} effective=${flag.effective} env_forced_off=${flag.env_forced_off}`);
    res.json({ flag });
  } catch (err) {
    console.error(`[flags] update failed (${err && err.code ? err.code : 'error'})`);
    res.status(500).json({ error: 'server_error' });
  }
});

module.exports = router;
module.exports.requireFlagApiKey = requireFlagApiKey;
