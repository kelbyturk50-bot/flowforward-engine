import { useEffect, useMemo, useState } from 'react';
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
  affiliationBanner,
  afterHoursNotice,
  capMessage,
  chipsFor,
  disclosureText,
  messageCodePoints,
} from './fixture.js';
import { INITIAL_LEAD, nextLead, respond, serviceLabel } from './respond.js';

function ToolCard({ tool }) {
  const notify = usePrototypeNotify();
  if (!tool?.name) return null;
  if (tool.name === 'offer_sample_slots') {
    return (
      <article className="live-chat-tool" data-tool="offer_sample_slots">
        <h3>Sample times</h3>
        <p>{SLOTS_LABEL}</p>
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
      </article>
    );
  }
  if (tool.name === 'flag_emergency') {
    return (
      <article className="live-chat-tool" data-tool="flag_emergency">
        <h3>Escalation</h3>
        <p>Urgency is {tool.args?.urgency || 'emergency'}.</p>
        <button type="button" className="live-chat-action" onClick={() => notify?.(liveToast('alert the on-call tech'))}>
          Note the emergency
        </button>
      </article>
    );
  }
  if (tool.name === 'capture_lead') {
    return (
      <article className="live-chat-tool" data-tool="capture_lead">
        <h3>Lead captured</h3>
        <p>{INITIAL_LEAD.customer}<SampleTag /></p>
        <p>{INITIAL_LEAD.phone}<SampleTag /></p>
        <p>{serviceLabel(tool.args?.service)}<SampleTag /></p>
      </article>
    );
  }
  if (tool.name === 'handoff_to_human') {
    return (
      <article className="live-chat-tool" data-tool="handoff_to_human">
        <h3>Handoff</h3>
        <p>{HANDOFF_LINE}</p>
        <button type="button" className="live-chat-action" onClick={() => notify?.(liveToast('ring the on-call tech'))}>
          Ring the on-call tech
        </button>
      </article>
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
  const count = messageCodePoints(draft);

  useEffect(() => {
    const previous = document.title;
    document.title = `${brand.name} live chat demo`;
    return () => { document.title = previous; };
  }, [brand.name]);

  function pushTurn(text, chipId) {
    const reply = respond({ facts: SAMPLE_FACTS, message: text, chipId });
    setTurns((current) => [
      ...current,
      { id: `${current.length}-user`, role: 'user', text },
      { id: `${current.length}-bot`, role: 'bot', text: reply.text, tools: reply.tools },
    ]);
    setLead((current) => nextLead(current, reply.tools));
  }

  function sendDraft() {
    const text = draft.trim();
    if (!text) return;
    pushTurn(text);
    setDraft('');
  }

  return (
    <PrototypeLayout brand={brand}>
      <main id="prototype-main" className="live-chat">
        <p className="live-chat-banner" role="note">{banner}</p>
        {afterHours ? <p className="live-chat-after" role="status">{afterHours}</p> : null}
        <div className="live-chat-stage">
          <section className="live-chat-phone" aria-label="Text-back">
            <header className="live-chat-phone-head">
              <span
                className="prototype-wordmark live-chat-wordmark"
                style={{ backgroundColor: 'var(--proto-accent)', color: 'var(--proto-on-accent)' }}
              >
                {brand.name}
              </span>
              <span className="live-chat-ai">{AI_DEMO_LABEL}</span>
            </header>
            <div className="live-chat-thread" role="log" aria-live="polite" aria-relevant="additions" aria-label="Messages">
              <p className="live-chat-bubble is-in" data-disclosure="true">{disclosure}</p>
              {turns.map((turn) => (
                <div key={turn.id} className="live-chat-turn">
                  <p className={`live-chat-bubble ${turn.role === 'user' ? 'is-out' : 'is-in'}`}>{turn.text}</p>
                  {turn.tools?.map((tool) => (
                    <ToolCard key={`${turn.id}-${tool.name}`} tool={tool} />
                  ))}
                </div>
              ))}
            </div>
            <div className="live-chat-chips" role="group" aria-label="Suggestions">
              {chips.map((chip) => (
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
              <p id="live-chat-count" className="live-chat-count" aria-live="polite">
                {count} / {MAX_MESSAGE_CHARS}
              </p>
              <button type="button" className="live-chat-send" disabled={!draft.trim()} onClick={sendDraft}>
                Send
              </button>
            </div>
          </section>
          <aside className="live-chat-owner" aria-label="Owner panel">
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
