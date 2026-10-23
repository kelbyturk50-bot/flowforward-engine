// REST API for the inbox: replies to proposals, Claude's read, drafted responses.
const express = require('express');
const router  = express.Router();
const inbox   = require('../proposals/inbox');

// 4xx messages are the ones this router throws on purpose. Anything else,
// including a database error, is a generic 500. The log is err.code only.
function fail(res, err) {
  const status = Number(err && err.status) || 0;
  if (status >= 400 && status < 500) {
    return res.status(status).json({ error: err.message || 'Not found' });
  }
  console.error('[inbox] request failed:', err && err.code ? err.code : 'error');
  return res.status(500).json({ error: 'Something went wrong.' });
}

// Integer ids only. parseInt('1 OR 1=1') would stop at the space.
function withId(handler) {
  return async (req, res) => {
    if (!/^\d{1,9}$/.test(String(req.params.id || ''))) {
      return res.status(404).json({ error: 'Not found' });
    }
    try {
      await handler(req, res, Number(req.params.id));
    } catch (err) {
      fail(res, err);
    }
  };
}

// GET /api/inbox?view=needs|fyi|handled
router.get('/', async (req, res) => {
  try {
    const [items, counts] = await Promise.all([inbox.list(req.query.view), inbox.counts()]);
    res.json({ items, counts });
  } catch (err) { fail(res, err); }
});

router.get('/counts', async (req, res) => {
  try { res.json(await inbox.counts()); } catch (err) { fail(res, err); }
});

// GET /api/inbox/:id — item, Claude's read, the draft, and the whole thread
router.get('/:id', withId(async (req, res, id) => {
  const item = await inbox.detail(id);
  if (!item) return res.status(404).json({ error: 'Not found' });
  res.json(item);
}));

// PATCH /api/inbox/:id { reply_body, reply_subject, reply_to }
router.patch('/:id', withId(async (req, res, id) => {
  res.json(await inbox.update(id, req.body || {}));
}));

router.post('/:id/send', withId(async (req, res, id) => {
  res.json(await inbox.sendReply(id));
}));
router.post('/:id/rewrite', withId(async (req, res, id) => {
  res.status(202).json(await inbox.rewrite(id, req.body?.instructions));
}));
router.post('/:id/handled', withId(async (req, res, id) => {
  res.json(await inbox.setStatus(id, 'handled', req.body?.note || null));
}));
router.post('/:id/discard', withId(async (req, res, id) => {
  res.json(await inbox.setStatus(id, 'discarded', 'Draft discarded'));
}));
router.post('/:id/reopen', withId(async (req, res, id) => {
  res.json(await inbox.reopen(id));
}));
router.post('/:id/apply', withId(async (req, res, id) => {
  const index = parseInt(req.body?.index, 10);
  if (!Number.isInteger(index) || index < 0) return res.status(400).json({ error: 'index is required' });
  res.json(await inbox.applySuggestion(id, index));
}));
router.post('/:id/seen', withId(async (req, res, id) => {
  await inbox.markSeen(id);
  res.json({ ok: true });
}));

module.exports = router;
