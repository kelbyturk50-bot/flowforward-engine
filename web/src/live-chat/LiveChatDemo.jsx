import { useEffect, useMemo, useRef, useState } from 'react';
import { SampleTag, liveToast, usePrototypeNotify } from '../components/PrototypeWatermark';
import { presentBrand } from '../prototypes/brand';
import PrototypeLayout from '../prototypes/PrototypeLayout';
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
  return turn.querySelector('.live-chat-bubble') || turn;
}

function leadChanged(before, after) {
  return before.service !== after.service
    || before.urgency !== after.urgency
    || before.alerted !== after.alerted
    || before.captured !== after.captured
    || before.customer !== after.customer
    || before.phone !== after.phone;
}

function ToolCard({ tool, open }) {
  const notify = usePrototypeNotify();
  if (!tool?.name) return null;
  if (tool.name === 'offer_sample_slots') {
    return (
      <details className="live-chat-tool" data-tool="offer_sample_slots" open={open}>
        <summary className="live-chat-expand">{SLOTS_LABEL}</summary>
        <ul className="live-chat-slots">
          {SAMPLE_SLOTS.map((slot) => (
            <li key={slot}>
              <button type="button" className="live-chat-action" onClick={() => notify?.(liveToast('book the slot'))}>
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
        <summary className="live-chat-expand">Flagged as an emergency in the sample.</summary>
        <p>Urgency is {tool.args?.urgency || 'emergency'}.</p>
        <button type="button" className="live-chat-action" onClick={() => notify?.(liveToast('alert the on-call tech'))}>
          Note the emergency
        </button>
      </details>
    );
  }
  if (tool.name === 'capture_lead') {
    return (
      <details className="live-chat-tool" data-tool="capture_lead" open={open}>
        <summary className="live-chat-expand">Lead card updated in the sample.</summary>
        <p>{INITIAL_LEAD.customer}<SampleTag /></p>
        <p>{INITIAL_LEAD.phone}<SampleTag /></p>
        <p>{serviceLabel(tool.args?.service)}<SampleTag /></p>
      </details>
    );
  }
  if (tool.name === 'handoff_to_human') {
    return (
      <details className="live-chat-tool" data-tool="handoff_to_human" open={open}>
        <summary className="live-chat-expand">{HANDOFF_LINE}</summary>
        <button type="button" className="live-chat-action" onClick={() => notify?.(liveToast('ring the on-call tech'))}>
          Ring the on-call tech
        </button>
      </details>
    );
  }
  return null;
}

export default function LiveChatDemo({ brandInput = SAMPLE_BRAND }) {
  const brand = useMemo(() => presentBrand(brandInput, { fallbackName: SAMPLE_BRAND.name }), [brandInput]);
  const chips = chipsFor(SAMPLE_FACTS);
  const disclosure = disclosureText(brand.name, SAMPLE_FACTS.phone);
  const banner = affiliationBanner(brand.name);
  const afterHours = afterHoursNotice(SAMPLE_FACTS);
  const [draft, setDraft] = useState('');
  const [turns, setTurns] = useState([]);
  const [lead, setLead] = useState(INITIAL_LEAD);
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
    const top = node.scrollTop + (target.getBoundingClientRect().top - node.getBoundingClientRect().top);
    const behavior = prefersReducedMotion() ? 'auto' : 'smooth';
    if (typeof node.scrollTo === 'function') node.scrollTo({ top, behavior });
    else node.scrollTop = top;
  }, [turns, typing]);

  function finishPending() {
    pending.current = Math.max(0, pending.current - 1);
    setTyping(pending.current > 0);
  }

  function deliver(text, chipId, userId) {
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
          }));
        const next = nextLead(leadRef.current, reply.tools);
        const changed = !ownerOpenRef.current && leadChanged(leadRef.current, next);
        leadRef.current = next;
        setLead(next);
        if (changed) setOwnerUpdates((updates) => updates + 1);
      } catch {
        setTurns((current) => current.map((turn) => (
          turn.id === userId ? { ...turn, pending: false, failed: true, chipId } : turn
        )));
      }
    }, TYPING_MS);
    timers.current.add(id);
  }

  function pushTurn(text, chipId) {
    const userId = `u-${seq.current}`;
    seq.current += 1;
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
    deliver(text, chipId, userId);
  }

  function retry(turn) {
    setTurns((current) => current.map((item) => (
      item.id === turn.id ? { ...item, pending: true, failed: false } : item
    )));
    deliver(turn.text, turn.chipId, turn.id);
  }

  function sendDraft() {
    const text = draft.trim();
    if (!text) return;
    setDraft('');
    pushTurn(text);
  }

  const unused = chips.filter((chip) => !usedChips.has(chip.id));
  const spent = chips.filter((chip) => usedChips.has(chip.id));
  const limitText = remaining === 0
    ? `Character limit reached. ${MAX_MESSAGE_CHARS} of ${MAX_MESSAGE_CHARS}.`
    : `${remaining} characters left.`;

  return (
    <PrototypeLayout brand={brand}>
      <main id="prototype-main" className="live-chat">
        <h1 className="live-chat-title">{brand.name}</h1>
        <div className={`live-chat-banner${bannerOpen ? ' is-open' : ''}`}>
          <button
            type="button"
            className="live-chat-banner-toggle"
            aria-expanded={bannerOpen}
            onClick={() => setBannerOpen((open) => !open)}
          >
            {BANNER_SUMMARY}
          </button>
          <p className={bannerOpen ? 'live-chat-banner-copy' : 'live-chat-banner-copy live-chat-sr'}>{banner}</p>
        </div>
        {afterHours ? <p className="live-chat-after" role="status">{afterHours}</p> : null}
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
        <div className="live-chat-stage">
          <section className="live-chat-phone" aria-label="Text-back">
            <header className="live-chat-phone-head">
              <span className="live-chat-ai">{AI_DEMO_LABEL}</span>
            </header>
            <div
              ref={threadRef}
              className="live-chat-thread"
              role="log"
              aria-live="polite"
              aria-relevant="additions"
              aria-label="Messages"
            >
              <p className="live-chat-bubble is-in" data-disclosure="true">{disclosure}</p>
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
                    <ToolCard key={`${turn.id}-${tool.name}`} tool={tool} open={turn.id === latestBotId} />
                  ))}
                </div>
              ))}
              {typing ? <p className="live-chat-typing" role="status">Typing…</p> : null}
            </div>
            <div className="live-chat-dock">
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
                {spent.length > 0 ? (
                  <details className="live-chat-earlier">
                    <summary className="live-chat-expand">Earlier suggestions</summary>
                    {spent.map((chip) => (
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
                  </details>
                ) : null}
              </div>
              <div className="live-chat-compose">
                <label className="live-chat-label" htmlFor="live-chat-input">Text the business</label>
                <textarea
                  id="live-chat-input"
                  className="live-chat-input"
                  rows={2}
                  value={draft}
                  aria-describedby="live-chat-count"
                  onChange={(event) => setDraft(capMessage(event.target.value))}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' && !event.shiftKey) {
                      event.preventDefault();
                      sendDraft();
                    }
                  }}
                />
                <p id="live-chat-count" className="live-chat-count">
                  {count} / {MAX_MESSAGE_CHARS}
                </p>
                <p className="live-chat-limit" role="status" aria-live="polite">
                  {nearLimit ? limitText : ''}
                </p>
                <button type="button" className="live-chat-send" disabled={!draft.trim()} onClick={sendDraft}>
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
