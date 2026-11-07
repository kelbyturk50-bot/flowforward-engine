import { useCallback, useEffect, useState } from 'react';
import { api } from '../api';
import { toast } from '../ui';

// What the live chat may say about this shop. Facts read from the research
// the proposal bot already saved start as "Needs review"; the chat uses only
// approved facts and says the team will confirm everything else. Nothing here
// fetches their website or calls the model.

// Display order: what a customer asks about first.
export const FACT_LABELS = {
  hours: 'Hours',
  phone: 'Phone',
  services: 'Services',
  service_area: 'Towns served',
  emergency_247: '24/7 emergency service',
  free_estimate: 'Free estimates',
  financing: 'Financing',
  maintenance_plan: 'Maintenance plan',
  license: 'Licensed',
  insurance: 'Insured',
  bonding: 'Bonded',
  address: 'Address',
  business_name: 'Business name',
  price: 'Price',
  license_number: 'License number',
  warranty: 'Warranty',
  guarantee: 'Guarantee',
  years_in_business: 'Years in business',
  time_zone: 'Time zone',
};

const ORDER = Object.keys(FACT_LABELS);
const rank = (field) => {
  const at = ORDER.indexOf(field);
  return at === -1 ? ORDER.length : at;
};

const ERRORS = {
  no_research: 'No research is saved for this lead yet. Draft a proposal first, then read again.',
  archived: 'This lead is archived.',
  not_found: 'Lead not found.',
};

function sourceLabel(fact) {
  if (fact.per_google) return 'per Google';
  if (fact.source === 'manual') return 'typed in the CRM';
  try { return new URL(fact.source_url).hostname.replace(/^www\./, ''); }
  catch { return 'their site'; }
}

function shown(fact) {
  return fact.value === 'yes' ? 'Yes' : fact.value;
}

export default function ChatFactsPanel({ prospectId }) {
  const [facts, setFacts] = useState(null);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    try {
      const r = await api.chatFacts(prospectId);
      setFacts(Array.isArray(r?.facts) ? r.facts : []);
      setError('');
    } catch (e) {
      setFacts([]);
      setError(ERRORS[e.message] || e.message);
    }
  }, [prospectId]);

  useEffect(() => { if (prospectId) load(); }, [prospectId, load]);

  const run = async (label, fn, done) => {
    setBusy(label);
    try {
      const r = await fn();
      if (Array.isArray(r?.facts)) setFacts(r.facts);
      setError('');
      if (done) toast(typeof done === 'function' ? done(r) : done);
    } catch (e) {
      setError(ERRORS[e.message] || e.message);
    } finally {
      setBusy('');
    }
  };

  const sorted = [...(facts || [])].sort((a, b) => rank(a.field) - rank(b.field));
  const proposed = sorted.filter((f) => f.review_status === 'proposed');

  return (
    <div className="chat-facts" aria-label="What the chat knows">
      <div className="chat-facts-head">
        <h4 className="col-title">What the chat knows</h4>
        <div className="link-row">
          <button type="button" className="btn btn-quiet" disabled={!!busy}
            onClick={() => run('build', () => api.buildChatFacts(prospectId), (r) => (r?.proposed
              ? `Found ${r.proposed} fact${r.proposed === 1 ? '' : 's'} to review.`
              : 'Nothing new in the saved research.'))}>
            {busy === 'build' ? 'Reading…' : 'Read from research'}
          </button>
          {proposed.length > 0 && (
            <button type="button" className="btn" disabled={!!busy}
              onClick={() => run('approve-all', () => api.approveChatFacts(prospectId), 'Approved. The chat can use these now.')}>
              {busy === 'approve-all' ? 'Approving…' : `Approve all (${proposed.length})`}
            </button>
          )}
        </div>
      </div>
      <p className="muted small">The chat only says what&apos;s approved here. For anything else it tells the customer the team will confirm.</p>
      {error ? <p className="error-note">{error}</p> : null}
      {facts === null ? <p className="muted small">Loading…</p>
        : facts.length === 0 ? <p className="muted small">No facts yet. Read from research to pull hours, services and towns from what the proposal bot saved.</p>
          : (
            <ul className="chat-facts-list">
              {sorted.map((fact) => {
                const label = FACT_LABELS[fact.field] || fact.field;
                const review = fact.review_status === 'proposed';
                return (
                  <li key={fact.field} className={review ? 'chat-fact is-proposed' : 'chat-fact'}>
                    <div className="chat-fact-main">
                      <span className="chat-fact-label">{label}</span>
                      <span className="chat-fact-value">{shown(fact)}</span>
                      {review ? <span className="chip chip-warn">Needs review</span> : null}
                      <span className="chat-fact-actions">
                        {review && (
                          <button type="button" className="btn btn-sm" disabled={!!busy} aria-label={`Approve ${label}`}
                            onClick={() => run(`approve-${fact.field}`, () => api.approveChatFacts(prospectId, [fact.field]))}>
                            Approve
                          </button>
                        )}
                        <button type="button" className="btn btn-sm btn-quiet" disabled={!!busy} aria-label={`Remove ${label}`}
                          onClick={() => run(`remove-${fact.field}`, () => api.removeChatFact(prospectId, fact.field), `${label} removed.`)}>
                          Remove
                        </button>
                      </span>
                    </div>
                    <p className="muted small chat-fact-source">
                      {fact.snippet ? <span className="chat-fact-quote">“{fact.snippet}”</span> : null}
                      {fact.snippet ? ' · ' : null}
                      {fact.source_url
                        ? <a href={fact.source_url} target="_blank" rel="noreferrer">{sourceLabel(fact)}</a>
                        : sourceLabel(fact)}
                    </p>
                  </li>
                );
              })}
            </ul>
          )}
    </div>
  );
}
