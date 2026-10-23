import { useState } from 'react';
import { api } from '../api';
import { formatDenverDate } from '../live-chat/dates';
import { demoChatUrl } from '../live-chat/route';
import { toast } from '../ui';

export const AGENT_LABELS = {
  estimate_followup: 'Estimate follow-up',
  speed_to_lead: 'Web lead reply',
  receptionist: 'Missed-call text-back',
  scheduling: 'Online booking',
};

const HEX = /^#[0-9a-fA-F]{6}$/;
const fmtDate = (d) => new Date(d).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });

// The lead's branded prototype: a sample homepage plus four agent demos on
// sample data. Kelby shares the link; nothing here sends anything.
export default function PrototypeCard({ prospectId, prototype, onChange }) {
  const [busy, setBusy] = useState('');
  const [proto, setProto] = useState(prototype || null);
  const [primary, setPrimary] = useState(prototype?.colors?.primary || '#2f6b57');
  const [secondary, setSecondary] = useState(prototype?.colors?.secondary || '#1e2a2f');
  const [confirmOff, setConfirmOff] = useState(false);
  const [swatches, setSwatches] = useState([]);

  const run = async (label, fn, msg) => {
    setBusy(label);
    try {
      const r = await fn();
      const next = r && 'prototype' in r ? r.prototype : null;
      setProto(next);
      if (next?.colors) { setPrimary(next.colors.primary); setSecondary(next.colors.secondary); }
      if (r && Array.isArray(r.swatches)) setSwatches(r.swatches);
      if (msg) toast(msg);
      onChange?.();
    } catch (e) { toast(e.message); } finally { setBusy(''); }
  };

  const copy = async () => {
    try { await navigator.clipboard.writeText(proto.url); toast('Prototype link copied.'); }
    catch { toast('Copy failed. Open the link and copy it from the address bar.'); }
  };

  const chatUrl = proto?.url && !proto.expired ? demoChatUrl(proto.url) : '';
  const chatExpiry = formatDenverDate(proto?.expires_at);
  const copyDemo = async () => {
    if (!chatUrl) return;
    try { await navigator.clipboard.writeText(chatUrl); toast('Demo link copied.'); }
    catch { toast('Select the demo link and copy it.'); }
  };
  const createDemo = () => run(
    'demo',
    () => api.createPrototype(prospectId, Boolean(proto?.expired)),
    'Demo link ready.',
  );

  if (!proto) {
    return (
      <section className="proto-card" aria-label="Prototype">
        <div className="proto-head"><h3 className="col-title">Prototype</h3></div>
        <p className="muted">A clickable sample for this shop: a homepage in their name and colors, plus estimate follow-up, web lead reply, missed-call text-back and online booking. Sample data only.</p>
        <button className="btn" disabled={!!busy} onClick={() => run('make', () => api.createPrototype(prospectId), 'Prototype ready.')}>
          {busy === 'make' ? 'Making…' : 'Make a prototype'}
        </button>
        <div className="demo-link-block">
          <h4 className="col-title">Live chat demo</h4>
          <p className="muted small">A text-back demo for this shop. Sample replies until the live model is on.</p>
          <button type="button" className="btn demo-link-copy" disabled={!!busy} onClick={createDemo}>
            {busy === 'demo' ? 'Creating…' : 'Create demo link'}
          </button>
        </div>
      </section>
    );
  }

  const colorsDirty = primary.toLowerCase() !== (proto.colors?.primary || '').toLowerCase()
    || secondary.toLowerCase() !== (proto.colors?.secondary || '').toLowerCase();
  const colorsValid = HEX.test(primary) && HEX.test(secondary);

  return (
    <section className="proto-card" aria-label="Prototype">
      <div className="proto-head">
        <h3 className="col-title">Prototype</h3>
        {proto.expired
          ? <span className="chip chip-warn">Expired {fmtDate(proto.expires_at)}</span>
          : <span className="muted small">Link works until {fmtDate(proto.expires_at)}</span>}
      </div>
      {proto.link_problem && (
        <p className="error-note">{proto.link_problem === 'key_missing'
          ? 'Links need the CRM API key on Railway to be at least 32 characters.'
          : 'The CRM API key changed, so this link no longer works. Make a new link.'}</p>
      )}
      {proto.url && !proto.expired && (
        <div className="link-row proto-link">
          <a className="btn" href={proto.url} target="_blank" rel="noreferrer">Open prototype</a>
          <button className="btn btn-quiet" onClick={copy}>Copy link</button>
          <code className="proto-url" title={proto.url}>{proto.url}</code>
        </div>
      )}
      <div className="demo-link-block">
        <h4 className="col-title">Live chat demo</h4>
        {chatUrl ? (
          <>
            {chatExpiry ? <p className="muted small">Works until {chatExpiry} (Mountain Time).</p> : null}
            <p className="demo-link-url" id="demo-chat-url">{chatUrl}</p>
            <button type="button" className="btn demo-link-copy" aria-describedby="demo-chat-url" onClick={copyDemo}>
              Copy demo link
            </button>
          </>
        ) : (
          <>
            <p className="muted small">A text-back demo for this shop. Sample replies until the live model is on.</p>
            <button type="button" className="btn demo-link-copy" disabled={!!busy} onClick={createDemo}>
              {busy === 'demo' ? 'Creating…' : 'Create demo link'}
            </button>
          </>
        )}
      </div>
      <div className="proto-grid">
        <label>Lead with
          <select className="input" value={proto.agent_type} disabled={!!busy}
            onChange={e => run('agent', () => api.updatePrototype(proto.id, { agent_type: e.target.value }), 'Saved.')}>
            {Object.entries(AGENT_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select>
        </label>
        <label>Main color
          <span className="proto-color">
            <input type="color" value={HEX.test(primary) ? primary : '#2f6b57'} onChange={e => setPrimary(e.target.value)} aria-label="Main color picker" />
            <input className="input" value={primary} onChange={e => setPrimary(e.target.value.trim())} maxLength={7} aria-label="Main color hex" />
          </span>
        </label>
        <label>Second color
          <span className="proto-color">
            <input type="color" value={HEX.test(secondary) ? secondary : '#1e2a2f'} onChange={e => setSecondary(e.target.value)} aria-label="Second color picker" />
            <input className="input" value={secondary} onChange={e => setSecondary(e.target.value.trim())} maxLength={7} aria-label="Second color hex" />
          </span>
        </label>
      </div>
      <div className="link-row proto-match">
        <button className="btn btn-quiet" disabled={!!busy} onClick={() => run('match', () => api.matchPrototypeColors(proto.id), 'Colors matched to their website.')}>
          {busy === 'match' ? 'Reading their site…' : 'Match their website colors'}
        </button>
        {swatches.length > 0 && (
          <span className="proto-swatches" aria-label="Colors found on their site">
            {swatches.map(s => (
              <button key={s.hex} type="button" className="proto-swatch" style={{ background: s.hex }} title={`Use ${s.hex} as the main color`}
                aria-label={`Use ${s.hex} as the main color`} onClick={() => setPrimary(s.hex)} />
            ))}
          </span>
        )}
      </div>
      <p className="muted small">Colors come from their website automatically when it can be read. Tap a swatch or type a hex to change them. Text colors are adjusted so they stay readable. No logos.</p>
      <div className="link-row">
        {colorsDirty && (
          <button className="btn btn-quiet" disabled={!!busy || !colorsValid}
            onClick={() => run('colors', () => api.updatePrototype(proto.id, { colors: { primary, secondary } }), 'Colors saved.')}>
            {busy === 'colors' ? 'Saving…' : 'Save colors'}
          </button>
        )}
        <button className="btn btn-quiet" disabled={!!busy}
          onClick={() => run('fresh', () => api.createPrototype(prospectId, true), 'New link ready. The old one is off.')}>
          {proto.expired ? 'Make a new link' : 'New link'}
        </button>
        {!confirmOff
          ? <button className="btn btn-quiet" disabled={!!busy} onClick={() => setConfirmOff(true)}>Turn off link</button>
          : <>
            <span className="small">Turn it off for good?</span>
            <button className="btn btn-danger" disabled={!!busy} onClick={() => run('off', async () => { await api.revokePrototype(proto.id); return { prototype: null }; }, 'Prototype link turned off.')}>Turn off</button>
            <button className="btn btn-quiet" onClick={() => setConfirmOff(false)}>Cancel</button>
          </>}
      </div>
    </section>
  );
}
