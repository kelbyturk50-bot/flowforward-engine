// GET/PUT /api/flags. Mounted after requireApiKey. Does not send mail.

const express = require('express');
const { isKnown } = require('../flags/registry');
const { listFlags, setFlag } = require('../flags/resolve');

const router = express.Router();

router.get('/', async (req, res) => {
  const flags = await listFlags();
  res.json({ flags });
});

router.put('/:name', async (req, res) => {
  const name = req.params.name;
  if (!isKnown(name)) return res.status(400).json({ error: 'unknown_flag' });
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
