import { useEffect, useMemo, useRef, useState } from 'react';
import { SampleTag, liveToast, usePrototypeNotify } from '../components/PrototypeWatermark';
import { normalizeHex, presentBrand } from '../prototypes/brand';
import PrototypeLayout from '../prototypes/PrototypeLayout';
import {
  INVALID_ERROR,
  LIMIT_NOTICE,
  PAUSE_LOCKED_MESSAGE,
  PAUSE_MESSAGE,
  TOO_LONG_ERROR,
} from './contract.js';
import {
  AI_DEMO_LABEL,
  CRM_CARD_TITLE,
  HANDOFF_LINE,
  MAX_MESSAGE_CHARS,
  MOCK_ALERT_LABEL,
  SAMPLE_BRAND,
  SAMPLE_FACTS,
  SAMPLE_SLOTS,
  SLOTS_LABEL,
  BANNER_SUMMARY,
  affiliationBanner,
  afterHoursNotice,
  capMessage,
  chipsFor,
  disclosureText,
  messageCodePoints,
} from './fixture.js';
import { INITIAL_LEAD, nextLead, respond, serviceLabel } from './respond.js';

const TYPING_MS = 400;
const NEAR_LIMIT = 50;

function prefersReducedMotion() {
  return window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches === true;
}

function threadScrollTarget(node, typing) {
  if (!node) return null;
  if (typing) return node.querySelector('.live-chat-typing');
  const turn = node.querySelector('.live-chat-turn:last-child');
  if (!turn) return null;
  return turn.querySelector('.live-chat-failed')
    || turn.querySelector('.live-chat-bubble')
    || turn;
}

function leadChanged(before, after) {
  return before.service !== after.service
    || before.urgency !== after.urgency
    || before.alerted !== after.alerted
    || before.captured !== after.captured
    || before.customer !== after.customer
    || before.phone !== after.phone;
}

function ToolCard({ tool, slots, open, onAction }) {
  const notify = usePrototypeNotify();
  const act = (label) => {
    onAction?.();
    notify?.(liveToast(label));
  };
  if (!tool?.name) return null;
  const summary = typeof tool.card === 'string' && tool.card ? tool.card : '';
  if (tool.name === 'offer_sample_slots') {
    const times = Array.isArray(slots) && slots.length ? slots : SAMPLE_SLOTS;
    return (
      <details className="live-chat-tool" data-tool="offer_sample_slots" open={open}>
        <summary className="live-chat-expand">{summary || SLOTS_LABEL}</summary>
        <ul className="live-chat-slots">
          {times.map((slot) => (
            <li key={slot}>
              <button type="button" className="live-chat-action" onClick={() => act('book the slot')}>
                {slot}
                <SampleTag />
              </button>
            </li>
          ))}
        </ul>
      </details>
    );
  }
  if (tool.name === 'flag_emergency') {
    return (
      <details className="live-chat-tool" data-tool="flag_emergency" open={open}>
        <summary className="live-chat-expand">{summary || 'Flagged as an emergency in the sample.'}</summary>
        <p>Urgency is {tool.args?.urgency || 'emergency'}.</p>
        <button type="button" className="live-chat-action" onClick={() => act('alert the on-call tech')}>
          Note the emergency
        </button>
      </details>
    );
  }
  if (tool.name === 'capture_lead') {
    return (
      <details className="live-chat-tool" data-tool="capture_lead" open={open}>
        <summary className="live-chat-expand">{summary || 'Lead card updated in the sample.'}</summary>
        <p>{INITIAL_LEAD.customer}<SampleTag /></p>
        <p>{INITIAL_LEAD.phone}<SampleTag /></p>
        <p>{serviceLabel(tool.args?.service)}<SampleTag /></p>
      </details>
    );
  }
  if (tool.name === 'handoff_to_human') {
    return (
      <details className="live-chat-tool" data-tool="handoff_to_human" open={open}>
        <summary className="live-chat-expand">{summary || HANDOFF_LINE}</summary>
        <button type="button" className="live-chat-action" onClick={() => act('ring the on-call tech')}>
          Ring the on-call tech
        </button>
      </details>
    );
  }
  return null;
}

function leadFromReply(current, data) {
  const tools = Array.isArray(data?.tools) ? data.tools : [];
  const next = nextLead(current, tools);
  const sample = data?.sample_lead || {};
  if (sample.name) next.customer = sample.name;
  if (sample.phone) next.phone = sample.phone;
  return next;
}

export default function LiveChatDemo({ brandInput = SAMPLE_BRAND, transport = null }) {
  const brand = useMemo(
    () => presentBrand(brandInput, { fallbackName: transport ? (brandInput?.name || 'this business') : SAMPLE_BRAND.name }),
    [brandInput, transport],
  );
  const chips = transport?.chips?.length ? transport.chips : (transport ? [] : chipsFor(SAMPLE_FACTS));
  const disclosure = transport ? (transport.disclosure || '') : disclosureText(brand.name, SAMPLE_FACTS.phone);
  const suppliedBanner = String(transport?.banner || '').trim();
  const banner = suppliedBanner || affiliationBanner(brand.name);
  const afterHours = transport
    ? afterHoursNotice(transport.facts || { hours: '' }, new Date())
    : afterHoursNotice(SAMPLE_FACTS);
  const secondary = normalizeHex(transport?.secondary || '');
  const transportRef = useRef(transport);
  transportRef.current = transport;
  const [draft, setDraft] = useState('');
  const [turns, setTurns] = useState([]);
  const [lead, setLead] = useState(INITIAL_LEAD);
  const [notice, setNotice] = useState(() => transport?.notice || null);
  const [locked, setLocked] = useState(() => Boolean(transport?.locked));
  const [inlineError, setInlineError] = useState('');
  const [usedChips, setUsedChips] = useState(() => new Set());
  const [bannerOpen, setBannerOpen] = useState(false);
  const [ownerOpen, setOwnerOpen] = useState(false);
  const [ownerUpdates, setOwnerUpdates] = useState(0);
  const [typing, setTyping] = useState(false);
  const threadRef = useRef(null);
  const leadRef = useRef(INITIAL_LEAD);
  const timers = useRef(new Set());
  const pending = useRef(0);
  const seq = useRef(0);
  const ownerOpenRef = useRef(false);
  const count = messageCodePoints(draft);
  const remaining = MAX_MESSAGE_CHARS - count;
  const nearLimit = remaining <= NEAR_LIMIT;
  const latestBotId = [...turns].reverse().find((turn) => turn.role === 'bot')?.id;

  useEffect(() => {
    ownerOpenRef.current = ownerOpen;
  }, [ownerOpen]);

  useEffect(() => {
    const previous = document.title;
    document.title = `${brand.name} live chat demo`;
    return () => { document.title = previous; };
  }, [brand.name]);

  useEffect(() => () => {
    for (const id of timers.current) window.clearTimeout(id);
    timers.current.clear();
  }, []);

  useEffect(() => {
    const node = threadRef.current;
    const target = threadScrollTarget(node, typing);
    if (!node || !target) return;
    const top = Math.max(0, node.scrollTop + (target.getBoundingClientRect().bottom - node.getBoundingClientRect().bottom));
    const behavior = prefersReducedMotion() ? 'auto' : 'smooth';
    if (typeof node.scrollTo === 'function') node.scrollTo({ top, behavior });
    else node.scrollTop = top;
  }, [turns, typing]);

  function finishPending() {
    pending.current = Math.max(0, pending.current - 1);
    setTyping(pending.current > 0);
  }

  function markFailed(userId, chipId) {
    setTurns((current) => current.map((turn) => (
      turn.id === userId ? { ...turn, pending: false, failed: true, chipId } : turn
    )));
  }

  function dropTurn(userId, chipId) {
    setTurns((current) => current.filter((turn) => turn.id !== userId));
    if (!chipId) return;
    setUsedChips((current) => {
      const next = new Set(current);
      next.delete(chipId);
      return next;
    });
  }

  function applyReply(userId, data) {
    const tools = Array.isArray(data.tools) ? data.tools : [];
    setTurns((current) => current
      .map((turn) => (turn.id === userId ? { ...turn, pending: false, failed: false } : turn))
      .concat({
        id: `${userId}-bot`,
        role: 'bot',
        text: data.text,
        tools,
        slots: Array.isArray(data.slots) ? data.slots : [],
      }));
    const next = leadFromReply(leadRef.current, data);
    const changed = !ownerOpenRef.current && leadChanged(leadRef.current, next);
    leadRef.current = next;
    setLead(next);
    if (changed) setOwnerUpdates((updates) => updates + 1);
    if (data.paused) setNotice({ kind: 'pause', text: data.pause_message || PAUSE_MESSAGE });
  }

  function deliver(text, chipId, userId, restore) {
    const live = transportRef.current;
    if (!live) {
      pending.current += 1;
      setTyping(true);
      const id = window.setTimeout(() => {
        timers.current.delete(id);
        finishPending();
        try {
          const reply = respond({ facts: SAMPLE_FACTS, message: text, chipId });
          setTurns((current) => current
            .map((turn) => (turn.id === userId ? { ...turn, pending: false, failed: false } : turn))
            .concat({
              id: `${userId}-bot`,
              role: 'bot',
              text: reply.text,
              tools: reply.tools,
              slots: reply.slots,
            }));
          const next = nextLead(leadRef.current, reply.tools);
          const changed = !ownerOpenRef.current && leadChanged(leadRef.current, next);
          leadRef.current = next;
          setLead(next);
          if (changed) setOwnerUpdates((updates) => updates + 1);
        } catch {
          markFailed(userId, chipId);
        }
      }, TYPING_MS);
      timers.current.add(id);
      return;
    }
    pending.current += 1;
    setTyping(true);
    live.send({ text, chipId }).then((result) => {
      const status = result?.status;
      const data = result?.data || {};
      if (status === 200 && typeof data.text === 'string') {
        applyReply(userId, data);
        return;
      }
      if (status === 400 || status === 413) {
        dropTurn(userId, chipId);
        if (restore != null) setDraft(restore);
        setInlineError(status === 413 ? TOO_LONG_ERROR : INVALID_ERROR);
        return;
      }
      if (status === 429) {
        setTurns((current) => current.map((turn) => (
          turn.id === userId ? { ...turn, pending: false, failed: false } : turn
        )));
        setDraft('');
        setLocked(true);
        setNotice({ kind: 'limit', text: LIMIT_NOTICE });
        return;
      }
      if (status === 503) {
        setTurns((current) => current.map((turn) => (
          turn.id === userId ? { ...turn, pending: false, failed: false } : turn
        )));
        setDraft('');
        setLocked(true);
        setNotice({ kind: 'pause', text: PAUSE_LOCKED_MESSAGE });
        return;
      }
      if (status === 410) {
        live.onExpired?.();
        return;
      }
      if (status === 404) {
        live.onNotFound?.();
        return;
      }
      markFailed(userId, chipId);
    }).catch(() => {
      markFailed(userId, chipId);
    }).finally(() => {
      finishPending();
    });
  }

  function pushTurn(text, chipId) {
    if (locked) return;
    const userId = `u-${seq.current}`;
    seq.current += 1;
    const restore = chipId ? null : text;
    if (!chipId) setDraft('');
    setInlineError('');
    setTurns((current) => [
      ...current,
      { id: userId, role: 'user', text, pending: true, failed: false, chipId },
    ]);
    if (chipId) {
      setUsedChips((current) => {
        const next = new Set(current);
        next.add(chipId);
        return next;
      });
    }
    deliver(text, chipId, userId, restore);
  }

  function retry(turn) {
    setTurns((current) => current.map((item) => (
      item.id === turn.id ? { ...item, pending: true, failed: false } : item
    )));
    deliver(turn.text, turn.chipId, turn.id);
  }

  function sendDraft() {
    const text = draft.trim();
    if (!text || locked) return;
    pushTurn(text);
  }

  const unused = chips.filter((chip) => !usedChips.has(chip.id));
  const limitText = remaining === 0
    ? `Character limit reached. ${MAX_MESSAGE_CHARS} of ${MAX_MESSAGE_CHARS}.`
    : `${remaining} characters left.`;

  return (
    <PrototypeLayout brand={brand}>
      <main
        id="prototype-main"
        className="live-chat"
      >
        <h1
          className="live-chat-title"
          style={secondary ? { boxShadow: `inset 0 -3px 0 ${secondary}` } : undefined}
        >
          {brand.name}
        </h1>
        <div className={`live-chat-banner${bannerOpen ? ' is-open' : ''}`}>
          <button
            type="button"
            className="live-chat-banner-toggle"
            aria-expanded={bannerOpen}
            onClick={() => setBannerOpen((open) => !open)}
          >
            {bannerOpen ? 'Sample by FlowForward · not affiliated · no real bookings · Hide' : BANNER_SUMMARY}
          </button>
          <p className={bannerOpen ? 'live-chat-banner-copy' : 'live-chat-banner-copy live-chat-sr'}>{banner}</p>
        </div>
        {transport?.voice || null}
        <div className="live-chat-stage">
          <section className="live-chat-phone" aria-label="Text-back">
            {notice?.text ? (
              <p className="live-chat-status" role="status" data-status={notice.kind}>{notice.text}</p>
            ) : null}
            <header className="live-chat-phone-head">
              <span className="live-chat-ai">{AI_DEMO_LABEL}</span>
              <button
                type="button"
                className="live-chat-owner-toggle"
                aria-expanded={ownerOpen}
                aria-controls="live-chat-owner"
                onClick={() => {
                  setOwnerOpen((open) => !open);
                  setOwnerUpdates(0);
                }}
              >
                <span>{ownerOpen ? 'Hide owner panel' : 'View owner panel'}</span>
                {ownerUpdates > 0 && !ownerOpen ? (
                  <span className="live-chat-badge">{ownerUpdates} update{ownerUpdates === 1 ? '' : 's'}</span>
                ) : null}
              </button>
            </header>
            <div
              ref={threadRef}
              className="live-chat-thread"
              role="log"
              aria-live="polite"
              aria-relevant="additions"
              aria-label="Messages"
            >
              {afterHours ? <p className="live-chat-after" role="status">{afterHours}</p> : null}
              {disclosure ? <p className="live-chat-bubble is-in" data-disclosure="true">{disclosure}</p> : null}
              {turns.map((turn) => (
                <div key={turn.id} className="live-chat-turn">
                  <p className={`live-chat-bubble ${turn.role === 'user' ? 'is-out' : 'is-in'}`}>{turn.text}</p>
                  {turn.failed ? (
                    <p className="live-chat-failed" role="alert">
                      {"This sample reply didn't load."}
                      <button type="button" className="live-chat-action" onClick={() => retry(turn)}>Retry</button>
                    </p>
                  ) : null}
                  {turn.tools?.map((tool) => (
                    <ToolCard
                      key={`${turn.id}-${tool.name}`}
                      tool={tool}
                      slots={turn.slots}
                      open={turn.id === latestBotId}
                      onAction={transport ? () => transportRef.current?.onCta?.() : undefined}
                    />
                  ))}
                </div>
              ))}
              {typing ? <p className="live-chat-typing" role="status">Typing…</p> : null}
            </div>
            <div className="live-chat-dock">
              {locked ? null : (
                <div className="live-chat-chips" role="group" aria-label="Suggestions">
                  <div className="live-chat-chip-row">
                    {unused.map((chip) => (
                      <button
                        key={chip.id}
                        type="button"
                        className="live-chat-chip"
                        data-chip={chip.id}
                        onClick={() => pushTurn(chip.label, chip.id)}
                      >
                        {chip.label}
                      </button>
                    ))}
                  </div>
                </div>
              )}
              <div className="live-chat-compose">
                <div className="live-chat-compose-head">
                  <label className="live-chat-label" htmlFor="live-chat-input">Text the business</label>
                  <p id="live-chat-count" className="live-chat-count">
                    {count} / {MAX_MESSAGE_CHARS}
                  </p>
                </div>
                {inlineError ? <p className="live-chat-inline" role="alert">{inlineError}</p> : null}
                <textarea
                  id="live-chat-input"
                  className="live-chat-input"
                  rows={1}
                  value={draft}
                  disabled={locked}
                  aria-describedby="live-chat-count"
                  onChange={(event) => setDraft(capMessage(event.target.value))}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' && !event.shiftKey) {
                      event.preventDefault();
                      sendDraft();
                    }
                  }}
                />
                <p className="live-chat-limit" role="status" aria-live="polite">
                  {nearLimit ? limitText : ''}
                </p>
                <button type="button" className="live-chat-send" disabled={locked || !draft.trim()} onClick={sendDraft}>
                  Send
                </button>
              </div>
            </div>
          </section>
          <aside id="live-chat-owner" className={`live-chat-owner${ownerOpen ? ' is-open' : ''}`} aria-label="Owner panel">
            <article className="prototype-card">
              <h2>Lead</h2>
              <p>{lead.customer}<SampleTag /></p>
              <p>Service: {lead.service}<SampleTag /></p>
              <p>Phone: {lead.phone}<SampleTag /></p>
            </article>
            <article className="prototype-card">
              <h2>Urgency</h2>
              <p>{lead.urgency}<SampleTag /></p>
            </article>
            <article className="prototype-card">
              <h2>{MOCK_ALERT_LABEL}</h2>
              <p>
                {lead.alerted
                  ? 'Emergency flagged for Sample customer. Nothing left this page.'
                  : 'No alert is queued.'}
                <SampleTag />
              </p>
            </article>
            <article className="prototype-card">
              <h2>{CRM_CARD_TITLE}</h2>
              <p>{lead.customer}<SampleTag /></p>
              <p>{lead.service}<SampleTag /></p>
              <p>{lead.urgency}<SampleTag /></p>
            </article>
          </aside>
        </div>
      </main>
    </PrototypeLayout>
  );
}
