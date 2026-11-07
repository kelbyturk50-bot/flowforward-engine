import { useEffect, useState } from 'react';
import PrototypeWatermark from '../components/PrototypeWatermark';
import LiveChatNotFound from './LiveChatNotFound';
import { normalizeHex } from '../prototypes/brand';
import LiveChatDemo from './LiveChatDemo';
import {
  EXPIRED_TITLE,
  LIMIT_NOTICE,
  LINK_LIFETIME,
  LINK_NEXT_STEP,
  LOAD_ERROR,
  PAUSE_LOCKED_MESSAGE,
} from './contract.js';
import { chipsFor } from './fixture.js';
import { publicJson } from './public-client.js';
import VoiceCallPanel from './VoiceCallPanel.jsx';

const CHIP_IDS = new Set(['chip_emergency', 'chip_booking', 'chip_price', 'chip_hours', 'chip_area']);

function chipsFrom(list) {
  if (!Array.isArray(list)) return [];
  return list.filter((chip) => (
    chip && CHIP_IDS.has(chip.id) && typeof chip.label === 'string' && chip.label.trim()
  )).map((chip) => ({ id: chip.id, label: chip.label }));
}

function factsObject(facts) {
  if (!Array.isArray(facts)) return null;
  const out = {};
  for (const fact of facts) {
    if (fact && typeof fact.field === 'string') out[fact.field] = fact.value;
  }
  return out;
}

function brandInputFrom(view) {
  const primary = view.colors?.primary || '';
  return {
    name: view.business_name || '',
    logoUrl: '',
    colors: { primary, accent: primary, ink: '#1E2A2F' },
  };
}

function viewFrom(data, demo) {
  const colors = (data && data.colors) || demo?.colors || {};
  return {
    banner: (data && data.banner) || demo?.banner || '',
    disclosure: (data && data.disclosure) || demo?.disclosure || '',
    business_name: (data && data.business_name) || demo?.business_name || '',
    colors,
    secondary: normalizeHex(colors.secondary || ''),
    facts: factsObject(demo?.facts) || null,
    chips: chipsFrom(demo?.chips),
  };
}

function chatPath(kind, { slug, token }, action) {
  if (kind === 'sample') {
    return `/api/public/chat/demos/${encodeURIComponent(slug)}/${action}`;
  }
  return `/api/public/prototypes/${encodeURIComponent(token)}/chat/${action}`;
}

function interpretSession(result, extra) {
  const data = result?.data || {};
  if (result?.status === 404) return { status: 'closed' };
  if (result?.status === 410) return { status: 'expired' };
  if (result?.status === 201 && typeof data.sessionId === 'string' && data.sessionId) {
    return { status: 'ready', data, locked: false, notice: null, ...extra };
  }
  if (result?.status === 503) {
    return {
      status: 'ready',
      data,
      locked: true,
      notice: { kind: 'pause', text: PAUSE_LOCKED_MESSAGE },
      ...extra,
    };
  }
  if (result?.status === 429) {
    return {
      status: 'ready',
      data,
      locked: true,
      notice: { kind: 'limit', text: LIMIT_NOTICE },
      ...extra,
    };
  }
  return { status: 'error', data };
}

async function openSample() {
  const listed = await publicJson('GET', '/api/public/chat/demos');
  if (listed.status === 404) return { status: 'closed' };
  const demos = listed.data?.demos;
  if (listed.status !== 200 || !Array.isArray(demos) || demos.length === 0) return { status: 'error' };
  const demo = demos[0];
  if (!demo || typeof demo.slug !== 'string' || !demo.slug) return { status: 'error' };
  const session = await publicJson('POST', chatPath('sample', { slug: demo.slug }, 'session'), {});
  return interpretSession(session, { kind: 'sample', slug: demo.slug, token: '', demo });
}

async function openPrototype(token) {
  const session = await publicJson('POST', chatPath('prototype', { token }, 'session'), {});
  const chips = chipsFor({ service_area: '' });
  return interpretSession(session, { kind: 'prototype', slug: '', token, demo: { chips } });
}

function ExpiredDemo() {
  return (
    <div className="prototype-root">
      <PrototypeWatermark />
      <main className="live-chat-expired">
        <div className="not-found-card">
          <h1>{EXPIRED_TITLE}</h1>
          <p>{LINK_LIFETIME}</p>
          <p>This link is no longer active.</p>
          <p>{LINK_NEXT_STEP}</p>
        </div>
      </main>
    </div>
  );
}

function BootError({ onRetry }) {
  return (
    <main className="demo">
      <div className="not-found-card">
        <p className="live-chat-failed" role="alert">
          {LOAD_ERROR}
          <button type="button" className="live-chat-action" onClick={onRetry}>Retry</button>
        </p>
      </div>
    </main>
  );
}

export default function LiveChatConnected({ kind = 'sample', token = '' }) {
  const [view, setView] = useState({ status: 'loading' });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;
    const open = kind === 'prototype' ? openPrototype(token) : openSample();
    open.then((next) => {
      if (!cancelled) setView(next);
    }).catch(() => {
      if (!cancelled) setView({ status: 'error' });
    });
    return () => { cancelled = true; };
  }, [kind, token, attempt]);

  if (view.status === 'loading') {
    return <main className="demo"><p className="demo-loading">Loading sample data…</p></main>;
  }
  if (view.status === 'closed') return <LiveChatNotFound />;
  if (view.status === 'expired') return <ExpiredDemo />;
  if (view.status === 'error') {
    return <BootError onRetry={() => setAttempt((value) => value + 1)} />;
  }

  const model = viewFrom(view.data, view.demo);
  const target = { slug: view.slug, token: view.token };

  async function send({ text, chipId }) {
    const body = { sessionId: view.data.sessionId, text };
    if (chipId) body.chipId = chipId;
    return publicJson('POST', chatPath(view.kind, target, 'message'), body);
  }

  function onCta() {
    const sessionId = view.data?.sessionId;
    if (!sessionId) return;
    publicJson('POST', chatPath(view.kind, target, 'cta'), { sessionId }).catch(() => {});
  }

  return (
    <LiveChatDemo
      key={`${view.kind}:${view.data?.sessionId || attempt}`}
      brandInput={brandInputFrom(model)}
      transport={{
        banner: model.banner,
        disclosure: model.disclosure,
        chips: model.chips,
        facts: model.facts,
        secondary: model.secondary,
        locked: view.locked,
        notice: view.notice,
        send,
        onCta,
        onExpired: () => setView({ status: 'expired' }),
        onNotFound: () => setView({ status: 'closed' }),
        voice: view.kind === 'prototype' && view.token
          ? <VoiceCallPanel token={view.token} businessName={model.business_name || 'this business'} />
          : null,
      }}
    />
  );
}
