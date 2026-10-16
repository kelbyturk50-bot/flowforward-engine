// GET/PUT /api/flags. Mounted after requireApiKey. Does not send mail.
// GET uses that guard only. PUT also refuses unless CRM_API_KEY passes the
// same strength check as pilot intake, and it refuses env-only flags.

const express = require('express');
const { crmApiKeyReady } = require('./key-ready');
const { isKnown, isWritable } = require('../flags/registry');
const { listFlags, setFlag } = require('../flags/resolve');

const router = express.Router();

router.get('/', async (req, res) => {
  const flags = await listFlags();
  res.json({ flags });
});

router.put('/:name', async (req, res) => {
  if (!crmApiKeyReady()) {
    console.log('[flags] put refused; writes disabled');
    return res.status(503).json({ error: 'writes_disabled' });
  }
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
