// Pilot #1 CSV intake. API key is enforced by the /api mount.
// FF_PILOT_ESTIMATE_RECOVERY must be exactly "true" or every route is 404
// and this file does not query. It does not send mail or accept forwarded mail.

const express = require('express');
const flags = require('../pilot/flags');
const { globalSendKilled } = require('../pilot/kill-switch');
const { MAX_CSV_BYTES, parseIntake } = require('../pilot/estimate-intake');
const store = require('../pilot/estimates');

const router = express.Router();
const csvBody = express.text({
  type: ['text/csv', 'text/plain', 'application/csv'],
  limit: MAX_CSV_BYTES,
});

const NOT_FOUND = { error: 'Not found' };

function sendJson(res, status, body) {
  res.set('Cache-Control', 'no-store');
  return res.status(status).json(body);
}

function closed(res) {
  return sendJson(res, 404, NOT_FOUND);
}

router.use((req, res, next) => {
  if (!flags.masterOn()) return closed(res);
  return next();
});

function customerIdParam(req) {
  const raw = String(req.params.customerId || '');
  if (!/^[1-9][0-9]{0,8}$/.test(raw)) return null;
  return Number(raw);
}

function validName(value) {
  if (typeof value !== 'string') return null;
  const name = value.trim().replace(/\s+/g, ' ');
  if (!name || name.length > 120 || /[\u0000-\u001F\u007F]/.test(name)) return null;
  return name;
}

function wantsLiveSend(body) {
  if (!body || typeof body !== 'object') return false;
  const camel = body.liveSendEnabled;
  const snake = body.live_send_enabled;
  return camel === true || camel === 'true' || snake === true || snake === 'true';
}

function readCsv(req) {
  if (typeof req.body === 'string') return req.body;
  if (req.body && typeof req.body === 'object' && typeof req.body.csv === 'string') return req.body.csv;
  return null;
}

function stamp(value) {
  if (value == null) return null;
  if (value instanceof Date) return value.toISOString();
  return String(value);
}

function toPublic(row) {
  return {
    sourceEstimateId: row.source_estimate_id,
    firstName: row.homeowner_first_name,
    email: row.email,
    jobType: row.job_type,
    amount: row.amount == null ? null : String(row.amount),
    estimateDate: row.estimate_date == null ? null : String(row.estimate_date),
    status: row.status,
    createdAt: stamp(row.created_at),
    updatedAt: stamp(row.updated_at),
  };
}

function csvCell(value) {
  const raw = value == null ? '' : String(value);
  if (/[",\n\r]/.test(raw)) return `"${raw.replace(/"/g, '""')}"`;
  return raw;
}

function toCsv(rows) {
  const header = [
    'estimate_id', 'first_name', 'email', 'job_type', 'amount',
    'estimate_date', 'status', 'created_at', 'updated_at',
  ];
  const lines = [header.join(',')];
  for (const row of rows) {
    const pub = toPublic(row);
    lines.push([
      pub.sourceEstimateId,
      pub.firstName,
      pub.email,
      pub.jobType,
      pub.amount,
      pub.estimateDate,
      pub.status,
      pub.createdAt,
      pub.updatedAt,
    ].map(csvCell).join(','));
  }
  return `${lines.join('\n')}\n`;
}

router.post('/customers', async (req, res) => {
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  if (wantsLiveSend(body)) {
    return sendJson(res, 400, {
      error: 'live_send_locked',
      message: 'live_send_enabled stays off',
    });
  }
  const name = validName(body.name);
  if (!name) return sendJson(res, 400, { error: 'invalid_customer', field: 'name' });
  try {
    const row = await store.createCustomer(name);
    return sendJson(res, 201, {
      id: row.id,
      name: row.name,
      liveSendEnabled: row.live_send_enabled === true,
      sendsKilled: globalSendKilled() || row.live_send_enabled !== true,
    });
  } catch (err) {
    if (err.code === '23514') return sendJson(res, 400, { error: 'invalid_customer', field: 'name' });
    console.error('[pilot-estimates] create customer failed:', err.code || 'error');
    return sendJson(res, 500, { error: 'server_error' });
  }
});

router.post('/customers/:customerId/estimates', csvBody, async (req, res) => {
  const customerId = customerIdParam(req);
  if (!customerId) return sendJson(res, 400, { error: 'invalid_customer' });
  const csv = readCsv(req);
  if (csv == null) return sendJson(res, 400, { error: 'csv_required' });
  const parsed = parseIntake(csv);
  if (!parsed.ok) return sendJson(res, parsed.status, parsed.body);
  try {
    const customer = await store.getCustomer(customerId);
    if (!customer) return closed(res);
    const upserted = await store.upsertEstimates(customerId, parsed.rows);
    return sendJson(res, 200, {
      customerId,
      received: parsed.received,
      upserted,
      errors: parsed.errors,
    });
  } catch (err) {
    console.error('[pilot-estimates] upsert failed:', err.code || 'error');
    return sendJson(res, 500, { error: 'server_error' });
  }
});

router.get('/customers/:customerId/estimates', async (req, res) => {
  const customerId = customerIdParam(req);
  if (!customerId) return sendJson(res, 400, { error: 'invalid_customer' });
  try {
    const customer = await store.getCustomer(customerId);
    if (!customer) return closed(res);
    const rows = await store.listEstimates(customerId);
    if (req.query.format === 'csv') {
      res.set('Cache-Control', 'no-store');
      res.set('X-Content-Type-Options', 'nosniff');
      res.set('Content-Type', 'text/csv; charset=utf-8');
      res.set('Content-Disposition', `attachment; filename="estimates-${customerId}.csv"`);
      return res.status(200).send(toCsv(rows));
    }
    return sendJson(res, 200, {
      customerId,
      estimates: rows.map(toPublic),
    });
  } catch (err) {
    console.error('[pilot-estimates] export failed:', err.code || 'error');
    return sendJson(res, 500, { error: 'server_error' });
  }
});

router.delete('/customers/:customerId/estimates', async (req, res) => {
  const customerId = customerIdParam(req);
  if (!customerId) return sendJson(res, 400, { error: 'invalid_customer' });
  try {
    const customer = await store.getCustomer(customerId);
    if (!customer) return closed(res);
    const deleted = await store.deleteEstimates(customerId);
    return sendJson(res, 200, { customerId, deleted });
  } catch (err) {
    console.error('[pilot-estimates] delete failed:', err.code || 'error');
    return sendJson(res, 500, { error: 'server_error' });
  }
});

router.use((err, req, res, next) => {
  const status = err && (err.status || err.statusCode);
  if (status === 413 || (err && err.type === 'entity.too.large')) {
    return sendJson(res, 413, { error: 'payload_too_large', maxBytes: MAX_CSV_BYTES });
  }
  return next(err);
});

module.exports = router;
