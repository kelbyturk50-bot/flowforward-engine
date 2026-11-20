// Prospect JSON. The two call-list keys exist only while FF_CALL_LIST is on.
// Callers pass the flag they already read. This does not query.

function presentProspect(row, flagOn) {
  if (!row || typeof row !== 'object') return row;
  const out = { ...row };
  if (!flagOn) {
    delete out.call_list_kind;
    delete out.call_list_set_at;
    return out;
  }
  const kind = out.call_list_kind;
  out.call_list_kind = kind == null || kind === '' ? null : kind;
  const at = out.call_list_set_at;
  out.call_list_set_at = at == null || at === '' ? null : new Date(at).toISOString();
  return out;
}

module.exports = { presentProspect };
