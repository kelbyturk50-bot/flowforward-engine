// Minimal CSV reader for Pilot #1 intake. No dependency.
// Commas, CRLF, quoted fields, and "" escapes. A notes column is not special
// here; the intake layer drops any header it does not know.

function parseCsv(text) {
  const src = String(text == null ? '' : text).replace(/^\uFEFF/, '');
  if (src.includes('\0')) return { ok: false, error: 'invalid_csv' };

  const records = [];
  let cells = [];
  let field = '';
  let inQuotes = false;
  let fieldStarted = false;
  let line = 1;
  let recordLine = 1;

  function endField() {
    cells.push(field);
    field = '';
    fieldStarted = false;
  }

  function endRecord() {
    endField();
    const blank = cells.every((cell) => String(cell).trim() === '');
    if (!blank) records.push({ line: recordLine, cells });
    cells = [];
    line += 1;
    recordLine = line;
  }

  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (inQuotes) {
      if (c === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          fieldStarted = true;
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        field += c;
        fieldStarted = true;
        if (c === '\n') line += 1;
      }
      continue;
    }
    if (c === '"') {
      if (!fieldStarted) {
        inQuotes = true;
        fieldStarted = true;
        continue;
      }
      field += c;
      fieldStarted = true;
      continue;
    }
    if (c === ',') {
      endField();
      continue;
    }
    if (c === '\n' || (c === '\r' && src[i + 1] !== '\n')) {
      endRecord();
      continue;
    }
    if (c === '\r') continue;
    field += c;
    fieldStarted = true;
  }

  if (inQuotes) return { ok: false, error: 'invalid_csv' };
  if (fieldStarted || cells.length || field.length) endRecord();
  return { ok: true, records };
}

module.exports = { parseCsv };
