// Validate a CSV of open estimates. This module does not write and does not send.
// Unknown columns, including notes, are ignored.

const { parseCsv } = require('./csv');

const MAX_CSV_BYTES = 256 * 1024;
const MAX_DATA_ROWS = 2000;

const STATUSES = new Set(['open', 'sold', 'lost', 'expired', 'opted_out']);

// Spreadsheet formula triggers, plus tab and CR. Intake rejects these at the
// start of an estimate id, email, or job type. A leading run is stripped from
// a first name so the stored value cannot open a formula.
const FORMULA_LEAD = /^[=+\-@\t\r]/;

// C1 controls, bidi overrides and isolates, and zero-width characters.
// Ordinary newlines are not in this set: a quoted CSV field may contain one,
// and it is collapsed to a space before the value is stored.
const HOSTILE_TEXT = /[\u007F-\u009F\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF]/;

const HEADER_ALIASES = {
  estimate_id: 'estimateId',
  source_estimate_id: 'estimateId',
  first_name: 'firstName',
  homeowner_first_name: 'firstName',
  email: 'email',
  job_type: 'jobType',
  amount: 'amount',
  estimate_date: 'estimateDate',
  date: 'estimateDate',
  status: 'status',
};

function normalizeHeader(value) {
  return String(value || '')
    .replace(/^\uFEFF/, '')
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, '_');
}

function cell(cells, index, field) {
  if (index[field] == null) return '';
  return cells[index[field]] == null ? '' : String(cells[index[field]]);
}

function validEstimateId(value) {
  const id = String(value || '').trim();
  if (FORMULA_LEAD.test(id)) return null;
  if (id.length < 1 || id.length > 80) return null;
  if (/[\u0000-\u001F\u007F\s]/.test(id) || HOSTILE_TEXT.test(id)) return null;
  return id;
}

function validEmail(value) {
  const email = String(value || '').trim().toLowerCase();
  if (FORMULA_LEAD.test(email)) return null;
  if (email.length < 3 || email.length > 254) return null;
  if (email.includes('..')) return null;
  if (!/^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/.test(email)) return null;
  const at = email.indexOf('@');
  const local = email.slice(0, at);
  const domain = email.slice(at + 1);
  if (!local || local.length > 64 || local.startsWith('.') || local.endsWith('.')) return null;
  if (!domain || domain.startsWith('.') || domain.endsWith('.') || domain.startsWith('-')) return null;
  if (HOSTILE_TEXT.test(email)) return null;
  return email;
}

function validFirstName(value) {
  const raw = String(value || '');
  if (HOSTILE_TEXT.test(raw)) return { ok: false };
  // Drop a leading formula trigger (= + - @ tab CR) before the name is stored.
  const name = raw.trim().replace(/^[=+\-@\t\r]+/, '').trim().replace(/\s+/g, ' ');
  if (!name) return { ok: true, value: null };
  if (name.length > 60 || HOSTILE_TEXT.test(name) || /[\u0000-\u001F\u007F]/.test(name) || name.includes('@')) {
    return { ok: false };
  }
  return { ok: true, value: name };
}

function validJobType(value) {
  const raw = String(value || '');
  if (HOSTILE_TEXT.test(raw)) return { ok: false };
  const job = raw.trim().replace(/\s+/g, ' ');
  if (!job) return { ok: true, value: null };
  if (FORMULA_LEAD.test(job)) return { ok: false };
  if (job.length > 80 || HOSTILE_TEXT.test(job) || /[\u0000-\u001F\u007F]/.test(job)) return { ok: false };
  return { ok: true, value: job };
}

function validAmount(value) {
  const raw = String(value || '').trim();
  if (!raw) return { ok: true, value: null };
  if (!/^\d{1,8}(\.\d{1,2})?$/.test(raw)) return { ok: false };
  return { ok: true, value: raw };
}

function validDate(value) {
  const raw = String(value || '').trim();
  if (!raw) return { ok: true, value: null };
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw);
  if (!match) return { ok: false };
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (year < 1990 || year > 2100) return { ok: false };
  const dt = new Date(Date.UTC(year, month - 1, day));
  if (dt.getUTCFullYear() !== year || dt.getUTCMonth() !== month - 1 || dt.getUTCDate() !== day) {
    return { ok: false };
  }
  return { ok: true, value: raw };
}

function validStatus(value) {
  const raw = String(value || '').trim().toLowerCase().replace(/[\s-]+/g, '_');
  if (!raw) return { ok: true, value: 'open' };
  if (!STATUSES.has(raw)) return { ok: false };
  return { ok: true, value: raw };
}

function mapHeaders(cells) {
  const index = {};
  cells.forEach((header, i) => {
    const field = HEADER_ALIASES[normalizeHeader(header)];
    if (field && index[field] == null) index[field] = i;
  });
  return index;
}

function validateRow(record, index) {
  const errors = [];
  const sourceEstimateId = validEstimateId(cell(record.cells, index, 'estimateId'));
  const email = validEmail(cell(record.cells, index, 'email'));
  const firstName = validFirstName(cell(record.cells, index, 'firstName'));
  const jobType = validJobType(cell(record.cells, index, 'jobType'));
  const amount = validAmount(cell(record.cells, index, 'amount'));
  const estimateDate = validDate(cell(record.cells, index, 'estimateDate'));
  const status = validStatus(cell(record.cells, index, 'status'));

  if (!sourceEstimateId) errors.push({ row: record.line, field: 'estimate_id', message: 'Estimate id is required' });
  if (!email) errors.push({ row: record.line, field: 'email', message: 'A valid email is required' });
  if (!firstName.ok) errors.push({ row: record.line, field: 'first_name', message: 'First name must be 60 characters or fewer' });
  if (!jobType.ok) errors.push({ row: record.line, field: 'job_type', message: 'Job type must be 80 characters or fewer' });
  if (!amount.ok) errors.push({ row: record.line, field: 'amount', message: 'Amount must be a number like 4200.50' });
  if (!estimateDate.ok) errors.push({ row: record.line, field: 'estimate_date', message: 'Estimate date must be YYYY-MM-DD' });
  if (!status.ok) errors.push({ row: record.line, field: 'status', message: 'Status must be open, sold, lost, expired, or opted_out' });

  if (errors.length) return { ok: false, errors };
  return {
    ok: true,
    row: {
      sourceEstimateId,
      firstName: firstName.value,
      email,
      jobType: jobType.value,
      amount: amount.value,
      estimateDate: estimateDate.value,
      status: status.value,
    },
  };
}

// Structural failures reject the whole file and must not be written.
// Row failures are reported; the valid rows are returned for upsert.
function parseIntake(text) {
  const bytes = Buffer.byteLength(String(text == null ? '' : text));
  if (bytes === 0 || String(text).trim() === '') {
    return { ok: false, status: 400, body: { error: 'empty_csv' } };
  }
  if (bytes > MAX_CSV_BYTES) {
    return { ok: false, status: 413, body: { error: 'payload_too_large', maxBytes: MAX_CSV_BYTES } };
  }

  const parsed = parseCsv(text);
  if (!parsed.ok) {
    return { ok: false, status: 400, body: { error: 'invalid_csv' } };
  }
  if (!parsed.records.length) {
    return { ok: false, status: 400, body: { error: 'empty_csv' } };
  }

  const header = parsed.records[0];
  const index = mapHeaders(header.cells);
  const missing = [];
  if (index.estimateId == null) missing.push('estimate_id');
  if (index.email == null) missing.push('email');
  if (missing.length) {
    return { ok: false, status: 400, body: { error: 'missing_columns', columns: missing } };
  }

  const data = parsed.records.slice(1);
  if (data.length > MAX_DATA_ROWS) {
    return {
      ok: false,
      status: 400,
      body: { error: 'too_many_rows', maxRows: MAX_DATA_ROWS },
    };
  }

  const errors = [];
  const byId = new Map();
  for (const record of data) {
    const result = validateRow(record, index);
    if (!result.ok) {
      errors.push(...result.errors);
      continue;
    }
    byId.set(result.row.sourceEstimateId, result.row);
  }

  return {
    ok: true,
    received: data.length,
    rows: [...byId.values()],
    errors,
  };
}

module.exports = {
  MAX_CSV_BYTES,
  MAX_DATA_ROWS,
  STATUSES,
  parseIntake,
};
