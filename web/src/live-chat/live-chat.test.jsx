import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { api } from '../api';
import { WATERMARK_TEXT } from '../components/PrototypeWatermark';
import { _setFeatureFlagsForTests, resetRemoteFlags } from '../flags';
import GalleryGate from '../prototypes/GalleryGate';
import { GALLERY_PREVIEW_TOKEN } from '../prototypes/route';
import * as remoteFlags from '../remote-flags';
import LiveChatDemo from './LiveChatDemo';
import LiveChatGate from './LiveChatGate';
import {
  DECLINE_PRICE,
  FALLBACK_REPLY,
  HANDOFF_LINE,
  IDENTITY_REPLY,
  SAMPLE_BUSINESS,
  SAMPLE_CUSTOMER,
  SAMPLE_CUSTOMER_PHONE,
  SAMPLE_FACTS,
  SLOTS_LABEL,
  affiliationBanner,
  afterHoursNotice,
  capMessage,
  chipsFor,
  disclosureText,
  messageCodePoints,
  officeClosed,
} from './fixture.js';
import { liveChatHref, liveChatRouteFromPath } from './route.js';
import { _failNextFixtureReply, respond } from './respond.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const webRoot = path.resolve(here, '../..');
const css = readFileSync(path.join(here, '../styles.css'), 'utf8');
const indexHtml = readFileSync(path.join(webRoot, 'index.html'), 'utf8');
const DISCLOSURE = disclosureText(SAMPLE_BUSINESS, SAMPLE_FACTS.phone);
const BANNER = affiliationBanner(SAMPLE_BUSINESS);
const AFTER_HOURS = "It's 8:12 PM. Your office is closed. The AI still answered.";
const BOTH = 'FF_PROTOTYPE_GALLERY,FF_LIVE_CHAT_DEMO';
const BANNED = [
  'same day',
  'same-day',
  'today',
  'tonight',
  'right away',
  'right now',
  'asap',
  'immediately',
  'within the hour',
  'within an hour',
  'in under an hour',
  'within 30 minutes',
  'within 60 minutes',
  'within 2 hours',
  'on your doorstep',
  'on the way',
  'guaranteed arrival',
];
const WITHIN = /\bwithin \d+ (minutes?|hours?)\b/i;

function at(pathAndSearch) {
  window.history.pushState({}, '', pathAndSearch);
}

function walkImports(startFile, seen = new Set()) {
  const pending = [startFile];
  while (pending.length) {
    const file = pending.pop();
    if (seen.has(file)) continue;
    seen.add(file);
    const text = readFileSync(file, 'utf8');
    const specs = [
      ...text.matchAll(/from\s+['"](\.[^'"]+)['"]/g),
      ...text.matchAll(/import\(\s*['"](\.[^'"]+)['"]\s*\)/g),
    ].map((match) => match[1]);
    for (const spec of specs) {
      const resolved = resolveImport(file, spec);
      expect(resolved, `${path.basename(file)} imports ${spec}`).toBeTruthy();
      pending.push(resolved);
    }
  }
  return seen;
}

function resolveImport(fromFile, spec) {
  const base = path.resolve(path.dirname(fromFile), spec);
  const candidates = [
    base,
    `${base}.js`,
    `${base}.jsx`,
    `${base}.mjs`,
    path.join(base, 'index.js'),
    path.join(base, 'index.jsx'),
  ];
  return candidates.find((candidate) => existsSync(candidate) && statSync(candidate).isFile()) || '';
}

describe('live chat demo', () => {
  let fetchMock;
  let matchMedia;
  let refreshSpy;

  beforeEach(() => {
    window.sessionStorage.clear();
    resetRemoteFlags();
    _failNextFixtureReply(0);
    fetchMock = vi.fn((...args) => {
      throw new Error(`live chat fetch ${args[0]}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    refreshSpy = vi.spyOn(remoteFlags, 'refreshRemoteFlags');
    api.flags.mockClear();
    matchMedia = window.matchMedia;
    window.matchMedia = vi.fn().mockImplementation((query) => ({
      matches: false,
      media: query,
      addEventListener() {},
      removeEventListener() {},
      addListener() {},
      removeListener() {},
      dispatchEvent() { return false; },
    }));
  });

  afterEach(() => {
    window.matchMedia = matchMedia;
    refreshSpy.mockRestore();
    resetRemoteFlags();
    _failNextFixtureReply(0);
    window.sessionStorage.clear();
    vi.stubGlobal('fetch', () => {
      throw new Error('Tests must not call fetch. The API client is mocked.');
    });
  });

  it('stays closed unless both preview flags are on, and never calls fetch', async () => {
    const cases = [
      ['', false],
      ['?flags=FF_LIVE_CHAT_DEMO', false],
      ['?flags=FF_PROTOTYPE_GALLERY', false],
      [`?flags=${BOTH}`, true],
    ];
    for (const [search, open] of cases) {
      window.sessionStorage.clear();
      at(`/demo/live-chat${search}`);
      const view = render(<LiveChatGate />);
      if (open) {
        expect(await screen.findByText(DISCLOSURE)).toBeInTheDocument();
        expect(screen.getByRole('heading', { level: 1, name: SAMPLE_BUSINESS })).toBeInTheDocument();
      } else {
        expect(screen.getByRole('heading', { name: 'Page not found' })).toBeInTheDocument();
        expect(screen.queryByText(DISCLOSURE)).not.toBeInTheDocument();
      }
      expect(fetchMock).not.toHaveBeenCalled();
      expect(refreshSpy).not.toHaveBeenCalled();
      expect(api.flags).not.toHaveBeenCalled();
      view.unmount();
    }

    window.sessionStorage.clear();
    _setFeatureFlagsForTests([
      { name: 'FF_PROTOTYPE_GALLERY', enabled: true, env_forced_off: false },
      { name: 'FF_LIVE_CHAT_DEMO', enabled: true, env_forced_off: false },
    ]);
    at('/demo/live-chat');
    const remote = render(<LiveChatGate />);
    expect(screen.getByRole('heading', { name: 'Page not found' })).toBeInTheDocument();
    expect(screen.queryByText(DISCLOSURE)).not.toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(refreshSpy).not.toHaveBeenCalled();
    expect(api.flags).not.toHaveBeenCalled();
    remote.unmount();

    at(`/demo/gallery/${GALLERY_PREVIEW_TOKEN}?flags=FF_PROTOTYPE_GALLERY`);
    render(<GalleryGate route={{ token: GALLERY_PREVIEW_TOKEN, screen: 'index' }} />);
    expect(await screen.findByRole('heading', { name: 'Prototype gallery' })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Try it live' })).not.toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(refreshSpy).not.toHaveBeenCalled();
  });

  it('opens the fixture demo from both preview flags and shows the gallery entry', async () => {
    at(`/demo/live-chat?flags=${BOTH}`);
    const demo = render(<LiveChatGate />);
    expect(await screen.findByText(DISCLOSURE)).toBeInTheDocument();
    expect(screen.getByText(BANNER)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Not affiliated\. Show notice/ })).toBeInTheDocument();
    expect(screen.getByText(AFTER_HOURS)).toBeInTheDocument();
    expect(screen.getByText('AI demo')).toBeInTheDocument();
    expect(screen.getByRole('note', { name: WATERMARK_TEXT })).toBeInTheDocument();
    expect(indexHtml).toContain('<meta name="referrer" content="no-referrer"');
    expect(document.head.querySelector('meta[name="robots"]')).toBeNull();
    expect(api.flags).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(refreshSpy).not.toHaveBeenCalled();
    demo.unmount();

    const search = `?flags=${BOTH}`;
    at(`/demo/gallery/${GALLERY_PREVIEW_TOKEN}${search}`);
    render(<GalleryGate route={{ token: GALLERY_PREVIEW_TOKEN, screen: 'index' }} />);
    const entry = await screen.findByRole('link', { name: 'Try it live' });
    expect(entry).toHaveAttribute('href', liveChatHref(search));
    expect(fetchMock).not.toHaveBeenCalled();
    expect(refreshSpy).not.toHaveBeenCalled();
  });

  it('renders fixture replies, tool cards, and the owner panel without calling fetch', async () => {
    const user = userEvent.setup();
    const { container } = render(<LiveChatDemo />);
    expect(screen.getByText(DISCLOSURE)).toBeInTheDocument();
    expect(screen.getByText(BANNER)).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 1, name: SAMPLE_BUSINESS })).toBeInTheDocument();
    expect(screen.getByRole('note', { name: WATERMARK_TEXT })).toBeInTheDocument();
    expect(within(screen.getByRole('complementary', { name: 'Owner panel' })).getByRole('heading', { name: 'Lead' }).closest('article')).toHaveTextContent(SAMPLE_CUSTOMER);
    expect(screen.getByRole('heading', { name: 'Urgency' }).closest('article')).toHaveTextContent('normal');
    expect(screen.getByRole('heading', { name: 'Mock alert, not sent' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Request created in your CRM (sample)' })).toBeInTheDocument();
    expect(container.querySelector('a[href^="tel:"], a[href^="mailto:"], a[href^="sms:"]')).toBeNull();
    expect(screen.getByRole('button', { name: /View owner panel/ })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'My water heater is leaking all over the garage' }));
    expect(await screen.findByText(/Typing…/)).toBeInTheDocument();
    expect(await screen.findByText(/marked this sample lead as an emergency/)).toBeInTheDocument();
    expect(container.querySelector('[data-tool="flag_emergency"]')).not.toBeNull();
    expect(container.querySelector('[data-tool="capture_lead"] summary')).toHaveTextContent('Lead card updated in the sample.');
    expect(container.querySelector('[data-tool="handoff_to_human"]')).toHaveTextContent(HANDOFF_LINE);
    expect(screen.getByRole('button', { name: /1 update/ })).toBeInTheDocument();
    const lead = screen.getByRole('heading', { name: 'Lead' }).closest('article');
    expect(lead).toHaveTextContent(SAMPLE_CUSTOMER);
    expect(lead).toHaveTextContent('Water heater');
    expect(lead).not.toHaveTextContent('leaking');
    expect(screen.getByRole('heading', { name: 'Urgency' }).closest('article')).toHaveTextContent('emergency');
    expect(screen.getByRole('heading', { name: 'Mock alert, not sent' }).closest('article')).toHaveTextContent('Nothing left this page.');
    const earlier = container.querySelector('.live-chat-earlier');
    expect(earlier).not.toBeNull();
    expect(earlier.open).toBe(false);
    expect(earlier.textContent).toContain('My water heater is leaking all over the garage');
    expect(container.querySelector('.live-chat-chip-row > [data-chip="chip_emergency"]')).toBeNull();
    expect(screen.getByText(DISCLOSURE)).toBeInTheDocument();
    expect(screen.getByText(BANNER)).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Can someone come out Tuesday?' }));
    expect(await screen.findByText(SLOTS_LABEL)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /Tuesday 9:00 AM/ }));
    expect(screen.getByText('In the live version this would book the slot.')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'How much for a new furnace?' }));
    expect(await screen.findByText(DECLINE_PRICE)).toBeInTheDocument();
    expect(screen.queryByText(/\$\d/)).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Are you open Saturday?' }));
    expect(await screen.findByText(/Hours on file are Monday–Friday, 8:00 AM–5:00 PM/)).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Do you service Sample Town?' }));
    expect(await screen.findByText('Sample Town is in the service area on file.')).toBeInTheDocument();

    const box = screen.getByLabelText('Text the business');
    await user.type(box, 'are you a human?');
    await user.click(screen.getByRole('button', { name: 'Send' }));
    expect(await screen.findByText(IDENTITY_REPLY)).toBeInTheDocument();

    await user.type(box, 'Do you install mini-splits?');
    await user.click(screen.getByRole('button', { name: 'Send' }));
    expect(await screen.findByText(FALLBACK_REPLY)).toBeInTheDocument();

    expect(screen.getByText(DISCLOSURE)).toBeInTheDocument();
    expect(screen.getByText(BANNER)).toBeInTheDocument();
    expect(screen.getByRole('note', { name: WATERMARK_TEXT })).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(refreshSpy).not.toHaveBeenCalled();
  }, 20000);

  it('keeps free-text out of the lead card and retries a fixture failure', async () => {
    const user = userEvent.setup();
    render(<LiveChatDemo />);
    const box = screen.getByLabelText('Text the business');
    await user.type(box, 'Pat Example (801) 555-0100');
    await user.click(screen.getByRole('button', { name: 'Send' }));
    expect(await screen.findByText(FALLBACK_REPLY)).toBeInTheDocument();
    const lead = screen.getByRole('heading', { name: 'Lead' }).closest('article');
    expect(lead).toHaveTextContent(SAMPLE_CUSTOMER);
    expect(lead).toHaveTextContent(SAMPLE_CUSTOMER_PHONE);
    expect(lead).not.toHaveTextContent('Pat Example');
    expect(lead).not.toHaveTextContent('555-0100');

    _failNextFixtureReply(1);
    await user.type(box, 'are you a bot?');
    await user.click(screen.getByRole('button', { name: 'Send' }));
    expect(await screen.findByRole('alert')).toHaveTextContent("This sample reply didn't load.");
    expect(screen.queryByText(IDENTITY_REPLY)).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText(IDENTITY_REPLY)).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  }, 15000);

  it('keeps the disclosure, banner, tile, and footer when the name is hostile markup', () => {
    const hostile = {
      name: '</div><script>alert(1)</script><style>.ribbon{display:none}</style>',
      logoUrl: 'https://prospect.example/logo.png',
      colors: { primary: '#FFFFFF', accent: '#FFFFFF', ink: 'transparent' },
    };
    at('/demo/live-chat?watermark=0');
    const { container } = render(<LiveChatDemo brandInput={hostile} />);
    expect(container.querySelector('script')).toBeNull();
    expect(container.querySelector('style')).toBeNull();
    expect(container.textContent).toContain('<style>.ribbon{display:none}</style>');
    expect(container.querySelector('[data-disclosure="true"]').textContent).toContain("I'm an AI receptionist demo");
    expect(container.querySelector('[data-disclosure="true"]').textContent).toContain('<style>.ribbon{display:none}</style>');
    expect(screen.getByText(/Not affiliated with or operated by/)).toBeInTheDocument();
    expect(screen.getByRole('note', { name: WATERMARK_TEXT })).toBeInTheDocument();
    expect(container.querySelector('[data-prototype-tile="true"]')).not.toBeNull();
    expect(container.querySelector('.prototype-footer')).not.toBeNull();
    expect(container.querySelector('.prototype-footer').textContent).toContain('not affiliated');
    expect(container.querySelector('img')).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('counts code points after NFKC, parses hours, and caps the composer at 500', () => {
    expect(messageCodePoints('👍')).toBe(1);
    expect(messageCodePoints('\uFF11\uFF12')).toBe(2);
    expect(capMessage(`${'a'.repeat(501)}`)).toHaveLength(500);
    expect(capMessage('\uFF11'.repeat(501))).toBe('1'.repeat(500));
    expect(afterHoursNotice(SAMPLE_FACTS)).toBe(AFTER_HOURS);
    expect(afterHoursNotice(SAMPLE_FACTS, new Date('2026-10-21T16:00:00.000Z'))).toBe('');
    expect(officeClosed({ ...SAMPLE_FACTS, hours: 'Monday-Friday, 8:00 AM-5:00 PM' })).toBe(true);
    expect(officeClosed({ ...SAMPLE_FACTS, hours: 'open late' })).toBe(false);
    expect(afterHoursNotice({ ...SAMPLE_FACTS, hours: 'open late' })).toBe('');
    expect(officeClosed({ ...SAMPLE_FACTS, hours: '' })).toBe(false);
    expect(disclosureText(SAMPLE_BUSINESS, '')).toContain('please call the business directly.');
    expect(liveChatRouteFromPath('/demo/live-chat')).toEqual({ screen: 'live-chat' });
    expect(liveChatRouteFromPath('/demo/live-chat/extra')).toBeNull();

    const visible = [
      DISCLOSURE,
      BANNER,
      AFTER_HOURS,
      FALLBACK_REPLY,
      IDENTITY_REPLY,
      DECLINE_PRICE,
      HANDOFF_LINE,
      SLOTS_LABEL,
      ...chipsFor(SAMPLE_FACTS).map((chip) => chip.label),
    ];
    for (const phrase of BANNED) {
      for (const text of visible) expect(text.toLowerCase(), phrase).not.toContain(phrase);
    }

    for (const chip of chipsFor(SAMPLE_FACTS)) {
      const reply = respond({ facts: SAMPLE_FACTS, message: chip.label, chipId: chip.id });
      expect(reply.source).toBe('fixture');
      expect(WITHIN.test(reply.text)).toBe(false);
      for (const phrase of BANNED) expect(reply.text.toLowerCase(), phrase).not.toContain(phrase);
    }
    expect(respond({ facts: SAMPLE_FACTS, message: 'are you a bot?' }).text).toBe(IDENTITY_REPLY);

    render(<LiveChatDemo />);
    const box = screen.getByLabelText('Text the business');
    expect(document.getElementById('live-chat-count')).not.toHaveAttribute('aria-live');
    fireEvent.change(box, { target: { value: 'a'.repeat(501) } });
    expect(box).toHaveValue('a'.repeat(500));
    expect(screen.getByText('500 / 500')).toBeInTheDocument();
    expect(screen.getByText('Character limit reached. 500 of 500.')).toBeInTheDocument();
    fireEvent.change(box, { target: { value: 'a'.repeat(449) } });
    expect(screen.queryByText(/characters left/)).not.toBeInTheDocument();
    fireEvent.change(box, { target: { value: 'a'.repeat(450) } });
    expect(screen.getByText('50 characters left.')).toBeInTheDocument();
    fireEvent.change(box, { target: { value: '👍👍' } });
    expect(screen.getByText('2 / 500')).toBeInTheDocument();
    const tap = css.slice(css.indexOf('.live-chat-chip, .live-chat-action, .live-chat-send {'));
    expect(tap.slice(0, 240)).toContain('min-height: 44px');
    const titleRule = css.slice(css.indexOf('.live-chat-title {'), css.indexOf('.live-chat-title {') + 180);
    expect(titleRule).toContain('overflow-wrap: anywhere');
    expect(css).toContain('border: 2px solid #3E4C4F');
    expect(css).not.toMatch(/\.live-chat-send:disabled\s*\{[^}]*opacity:\s*\.55/);
    expect(css).toContain('.live-chat-bubble.is-out');
    expect(css).toContain('.live-chat-send {');
  });

  it('does not call fetch from the live chat import graph', () => {
    const files = readdirSync(here).filter((name) => (name.endsWith('.js') || name.endsWith('.jsx')) && !name.endsWith('.test.jsx'));
    expect(files.length).toBeGreaterThan(0);
    const seen = new Set();
    for (const name of files) walkImports(path.join(here, name), seen);
    const names = [...seen].map((file) => path.basename(file));
    expect(names).toContain('LiveChatDemo.jsx');
    expect(names).toContain('fixture.js');
    expect(names).not.toContain('api.js');
    expect(names).not.toContain('remote-flags.js');
    for (const file of seen) {
      const text = readFileSync(file, 'utf8');
      expect(text, file).not.toMatch(/\bfetch\s*\(/);
      expect(text, file).not.toMatch(/from ['"][^'"]*\/api(?:\.js)?['"]/);
      expect(text, file).not.toMatch(/from ['"][^'"]*remote-flags(?:\.js)?['"]/);
      expect(text, file).not.toMatch(/anthropic|googleapis|twilio|sendMail|nodemailer/i);
    }
  });
});
