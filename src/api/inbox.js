// REST API for the inbox: replies to proposals, Claude's read, drafted responses.
const express = require('express');
const router  = express.Router();
const inbox   = require('../proposals/inbox');

const fail = (res, err) => res.status(err.status || 500).json({ error: err.message });
const idOf = (req) => parseInt(req.params.id, 10);

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
router.get('/:id', async (req, res) => {
  try {
    const item = await inbox.detail(idOf(req));
    if (!item) return res.status(404).json({ error: 'Not found' });
    res.json(item);
  } catch (err) { fail(res, err); }
});

// PATCH /api/inbox/:id { reply_body, reply_subject, reply_to }
router.patch('/:id', async (req, res) => {
  try { res.json(await inbox.update(idOf(req), req.body || {})); } catch (err) { fail(res, err); }
});

router.post('/:id/send', async (req, res) => {
  try { res.json(await inbox.sendReply(idOf(req))); } catch (err) { fail(res, err); }
});
router.post('/:id/rewrite', async (req, res) => {
  try { res.status(202).json(await inbox.rewrite(idOf(req), req.body?.instructions)); } catch (err) { fail(res, err); }
});
router.post('/:id/handled', async (req, res) => {
  try { res.json(await inbox.setStatus(idOf(req), 'handled', req.body?.note || null)); } catch (err) { fail(res, err); }
});
router.post('/:id/discard', async (req, res) => {
  try { res.json(await inbox.setStatus(idOf(req), 'discarded', 'Draft discarded')); } catch (err) { fail(res, err); }
});
router.post('/:id/reopen', async (req, res) => {
  try { res.json(await inbox.reopen(idOf(req))); } catch (err) { fail(res, err); }
});
router.post('/:id/apply', async (req, res) => {
  const index = parseInt(req.body?.index, 10);
  if (!Number.isInteger(index) || index < 0) return res.status(400).json({ error: 'index is required' });
  try { res.json(await inbox.applySuggestion(idOf(req), index)); } catch (err) { fail(res, err); }
});
router.post('/:id/seen', async (req, res) => {
  try { await inbox.markSeen(idOf(req)); res.json({ ok: true }); } catch (err) { fail(res, err); }
});

module.exports = router;
