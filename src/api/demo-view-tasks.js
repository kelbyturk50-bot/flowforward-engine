// Today tasks for a qualifying proposal view. Mounted after requireApiKey.
// When FF_DEMO_VIEW_TASK is off, every route is 404 and writes nothing.
// This router does not import the mail transport.

const express = require('express');
const { demoViewTaskOn } = require('../demo-view/flag');
const store = require('../demo-view/store');

const router = express.Router();

function notFound(res) {
  res.set('Cache-Control', 'no-store');
  return res.status(404).json({ error: 'not_found' });
}

router.use((req, res, next) => {
  if (!demoViewTaskOn()) return notFound(res);
  return next();
});

function pathId(value) {
  if (typeof value !== 'string' || !/^[1-9]\d{0,17}$/.test(value)) return null;
  const n = Number(value);
  if (!Number.isSafeInteger(n)) return null;
  return n;
}

function fail(res, err) {
  const status = err && err.status;
  if (status === 404) return notFound(res);
  if (status === 409) {
    res.set('Cache-Control', 'no-store');
    return res.status(409).json({ error: 'task_not_open' });
  }
  const code = err && typeof err.code === 'string' ? err.code : 'error';
  console.error(`[demo-view] ${code}`);
  res.set('Cache-Control', 'no-store');
  return res.status(500).json({ error: 'Something went wrong.' });
}

router.get('/metrics', async (req, res) => {
  try {
    const body = await store.taskMetrics();
    res.set('Cache-Control', 'no-store');
    res.json(body);
  } catch (err) {
    fail(res, err);
  }
});

router.get('/', async (req, res) => {
  try {
    const body = await store.listOpenTasks();
    res.set('Cache-Control', 'no-store');
    res.json(body);
  } catch (err) {
    fail(res, err);
  }
});

async function act(req, res, fn) {
  const id = pathId(req.params.id);
  if (!id) return notFound(res);
  try {
    const body = await fn(id);
    res.set('Cache-Control', 'no-store');
    res.json(body);
  } catch (err) {
    fail(res, err);
  }
}

router.post('/:id/done', (req, res) => act(req, res, store.markDone));
router.post('/:id/snooze', (req, res) => act(req, res, store.snoozeTask));
router.post('/:id/dismiss', (req, res) => act(req, res, store.dismissTask));

module.exports = router;
