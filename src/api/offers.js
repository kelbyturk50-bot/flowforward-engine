// Offer tracking HTTP API. Closed unless FF_OFFER_TRACKING is exactly "true".
// Records offers only. Does not import a mail transport.
//
// Mount order in server.js:
//   1. flagGate on /api/offers and /api/leads, before requireApiKey.
//      Anything other than exactly "true" leaves the router, which is the
//      same 404 as an unknown path, with or without a request key.
//   2. requireApiKey. A missing or wrong key is 401. An unready key is 503.

const express = require('express');
const store = require('../offers/store');

const NOTES_MAX = 2000;
const CREATE_FIELDS = new Set([
  'prospect_id',
  'offer_type',
  'package',
  'channel',
  'offered_at',
  'status',
  'notes',
  'is_test',
  'confirm_over_cap',
]);
const PATCH_FIELDS = new Set(['status', 'confirm_over_cap']);
const OFFERED_AT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;

const router = express.Router();
const leadsRouter = express.Router();

function offerTrackingOn() {
  return process.env.FF_OFFER_TRACKING === 'true';
}

function flagGate(req, res, next) {
  if (req.method === 'OPTIONS') return next();
  if (!offerTrackingOn()) return next('router');
  return next();
}

function invalid(res, field) {
  const safe = typeof field === 'string' && /^[a-z_]{1,40}$/.test(field) ? field : 'body';
  return res.status(400).json({ error: 'invalid_body', field: safe });
}

function capBody(slots) {
  return { warning: 'founding_cap', founding_slots: slots };
}

function pathId(value) {
  if (typeof value !== 'string' || !/^[1-9]\d{0,9}$/.test(value)) return null;
  const n = Number(value);
  if (!Number.isInteger(n) || n > 2147483647) return null;
  return n;
}

function bodyId(value) {
  if (typeof value !== 'number' || !Number.isInteger(value)) return null;
  if (value < 1 || value > 2147483647) return null;
  return value;
}

function objectBody(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  return body;
}

function unknownField(body, allowed) {
  for (const key of Object.keys(body)) {
    if (!allowed.has(key)) return key;
  }
  return null;
}

function oneOf(value, allowed) {
  return typeof value === 'string' && allowed.includes(value);
}

function readOfferedAt(value) {
  if (typeof value !== 'string' || value.length > 40 || !OFFERED_AT.test(value)) return null;
  const ms = Date.parse(value);
  if (Number.isNaN(ms)) return null;
  return new Date(ms).toISOString();
}

function readNotes(value) {
  if (value == null) return { ok: true, notes: null };
  if (typeof value !== 'string') return { ok: false };
  if (value.length > NOTES_MAX) return { ok: false };
  if (value.includes('\0')) return { ok: false };
  return { ok: true, notes: value };
}

function readCreate(body) {
  const raw = objectBody(body);
  if (!raw) return { ok: false, field: 'body' };
  const extra = unknownField(raw, CREATE_FIELDS);
  if (extra) return { ok: false, field: extra };
  const leadId = bodyId(raw.prospect_id);
  if (leadId == null) return { ok: false, field: 'prospect_id' };
  if (!oneOf(raw.offer_type, store.OFFER_TYPES)) return { ok: false, field: 'offer_type' };
  if (!oneOf(raw.package, store.PACKAGES)) return { ok: false, field: 'package' };
  if (!oneOf(raw.channel, store.CHANNELS)) return { ok: false, field: 'channel' };
  let status = 'offered';
  if (Object.prototype.hasOwnProperty.call(raw, 'status')) {
    if (!oneOf(raw.status, store.STATUSES)) return { ok: false, field: 'status' };
    status = raw.status;
  }
  let offeredAt = null;
  if (Object.prototype.hasOwnProperty.call(raw, 'offered_at') && raw.offered_at != null) {
    offeredAt = readOfferedAt(raw.offered_at);
    if (!offeredAt) return { ok: false, field: 'offered_at' };
  }
  let notes = null;
  if (Object.prototype.hasOwnProperty.call(raw, 'notes')) {
    const parsed = readNotes(raw.notes);
    if (!parsed.ok) return { ok: false, field: 'notes' };
    notes = parsed.notes;
  }
  let isTest = false;
  if (Object.prototype.hasOwnProperty.call(raw, 'is_test')) {
    if (typeof raw.is_test !== 'boolean') return { ok: false, field: 'is_test' };
    isTest = raw.is_test;
  }
  let confirm = false;
  if (Object.prototype.hasOwnProperty.call(raw, 'confirm_over_cap')) {
    if (typeof raw.confirm_over_cap !== 'boolean') return { ok: false, field: 'confirm_over_cap' };
    confirm = raw.confirm_over_cap;
  }
  return {
    ok: true,
    value: {
      prospect_id: leadId,
      offer_type: raw.offer_type,
      package: raw.package,
      channel: raw.channel,
      offered_at: offeredAt,
      status,
      notes,
      is_test: isTest,
      confirm_over_cap: confirm,
    },
  };
}

function readPatch(body) {
  const raw = objectBody(body);
  if (!raw) return { ok: false, field: 'body' };
  const extra = unknownField(raw, PATCH_FIELDS);
  if (extra) return { ok: false, field: extra };
  if (!oneOf(raw.status, store.STATUSES)) return { ok: false, field: 'status' };
  let confirm = false;
  if (Object.prototype.hasOwnProperty.call(raw, 'confirm_over_cap')) {
    if (typeof raw.confirm_over_cap !== 'boolean') return { ok: false, field: 'confirm_over_cap' };
    confirm = raw.confirm_over_cap;
  }
  return { ok: true, value: { status: raw.status, confirm_over_cap: confirm } };
}

function logCode(err) {
  console.error(`[offers] failed (${err && err.code ? err.code : 'error'})`);
}

router.get('/', async (req, res) => {
  try {
    const body = await store.listOffers();
    console.log(
      `[offers] list count=${body.offers.length}`
      + ` founding_used=${body.summary.founding_slots.used}`
      + ` founding_pending=${body.summary.founding_slots.pending}`
    );
    res.json(body);
  } catch (err) {
    logCode(err);
    res.status(500).json({ error: 'Something went wrong.' });
  }
});

router.post('/', async (req, res) => {
  const parsed = readCreate(req.body);
  if (!parsed.ok) return invalid(res, parsed.field);
  try {
    const result = await store.createOffer(parsed.value);
    if (result.code === 'invalid_lead') return invalid(res, 'prospect_id');
    if (result.code === 'founding_cap') {
      console.log('[offers] founding_cap create');
      return res.status(409).json(capBody(result.founding_slots));
    }
    console.log(`[offers] create id=${result.offer.id} type=${result.offer.offer_type} status=${result.offer.status}`);
    res.status(201).json({ offer: result.offer });
  } catch (err) {
    logCode(err);
    if (err && (err.code === '23503' || err.code === '23514')) return invalid(res, 'prospect_id');
    res.status(500).json({ error: 'Something went wrong.' });
  }
});

router.patch('/:id', async (req, res) => {
  const id = pathId(req.params.id);
  if (id == null) return res.status(404).json({ error: 'not_found' });
  const parsed = readPatch(req.body);
  if (!parsed.ok) return invalid(res, parsed.field);
  try {
    const result = await store.updateStatus(id, parsed.value);
    if (result.code === 'not_found') return res.status(404).json({ error: 'not_found' });
    if (result.code === 'founding_cap') {
      console.log('[offers] founding_cap patch');
      return res.status(409).json(capBody(result.founding_slots));
    }
    console.log(`[offers] patch id=${result.offer.id} status=${result.offer.status}`);
    res.json({ offer: result.offer });
  } catch (err) {
    logCode(err);
    res.status(500).json({ error: 'Something went wrong.' });
  }
});

leadsRouter.get('/:id/offers', async (req, res) => {
  const id = pathId(req.params.id);
  if (id == null) return res.status(404).json({ error: 'not_found' });
  try {
    const offers = await store.listForLead(id);
    if (!offers) return res.status(404).json({ error: 'not_found' });
    console.log(`[offers] lead count=${offers.length}`);
    res.json({ offers });
  } catch (err) {
    logCode(err);
    res.status(500).json({ error: 'Something went wrong.' });
  }
});

module.exports = {
  flagGate,
  router,
  leadsRouter,
  offerTrackingOn,
};
