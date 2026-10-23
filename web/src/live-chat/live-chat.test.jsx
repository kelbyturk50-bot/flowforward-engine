import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { api } from '../api';
import { WATERMARK_TEXT } from '../components/PrototypeWatermark';
import { _setFeatureFlagsForTests, _setFlagRuntimeForTests, resetRemoteFlags } from '../flags';
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
  BANNER_SUMMARY,
  affiliationBanner,
  afterHoursNotice,
  capMessage,
  chipsFor,
  disclosureText,
  messageCodePoints,
  officeClosed,
} from './fixture.js';
import { liveChatHref, liveChatRouteFromPath, prototypeChatFromPath } from './route.js';
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

function chatCalls(mock) {
  return mock.mock.calls
    .map((call) => String(call[0]))
    .filter((url) => url.includes('/api/public/chat') || url.includes('/api/public/prototypes'));
}

function expectPublicCall(call) {
  const headers = call[1]?.headers || {};
  const names = Object.keys(headers).map((name) => name.toLowerCase());
  expect(names).not.toContain('x-api-key');
  expect(names).not.toContain('authorization');
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
    _setFlagRuntimeForTests(null);
    window.sessionStorage.clear();
    vi.stubGlobal('fetch', () => {
      throw new Error('Tests must not call fetch. The API client is mocked.');
    });
  });

  it('stays closed unless both preview flags are on, and never calls the chat API', async () => {
    const cases = [
      ['', false],
      ['?flags=FF_LIVE_CHAT_DEMO', false],
      ['?flags=FF_PROTOTYPE_GALLERY', false],
      [`?flags=${BOTH}`, true],
    ];
    for (const [search, open] of cases) {
      window.sessionStorage.clear();
      fetchMock.mockClear();
      at(`/demo/live-chat${search}`);
      const view = render(<LiveChatGate />);
      if (open) {
        expect(await screen.findByText(DISCLOSURE)).toBeInTheDocument();
        expect(screen.getByRole('heading', { level: 1, name: SAMPLE_BUSINESS })).toBeInTheDocument();
      } else {
        expect(await screen.findByRole('heading', { name: 'Page not found' })).toBeInTheDocument();
        expect(screen.queryByText(DISCLOSURE)).not.toBeInTheDocument();
      }
      expect(chatCalls(fetchMock)).toEqual([]);
      expect(refreshSpy).not.toHaveBeenCalled();
      expect(api.flags).not.toHaveBeenCalled();
      if (open) expect(fetchMock).not.toHaveBeenCalled();
      for (const call of fetchMock.mock.calls) expectPublicCall(call);
      view.unmount();
    }

    window.sessionStorage.clear();
    _setFeatureFlagsForTests([
      { name: 'FF_PROTOTYPE_GALLERY', enabled: true, env_forced_off: false },
      { name: 'FF_LIVE_CHAT_DEMO', enabled: true, env_forced_off: false },
    ]);
    fetchMock.mockClear();
    at('/demo/live-chat');
    const remote = render(<LiveChatGate />);
    expect(await screen.findByRole('heading', { name: 'Page not found' })).toBeInTheDocument();
    expect(screen.queryByText(DISCLOSURE)).not.toBeInTheDocument();
    expect(chatCalls(fetchMock)).toEqual([]);
    expect(refreshSpy).not.toHaveBeenCalled();
    expect(api.flags).not.toHaveBeenCalled();
    remote.unmount();

    fetchMock.mockClear();
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
    const bannerButton = screen.getByRole('button', { name: BANNER_SUMMARY });
    expect(bannerButton).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(bannerButton);
    expect(screen.getByRole('button', { name: 'Sample by FlowForward · not affiliated · no real bookings · Hide' })).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByText(AFTER_HOURS)).toBeInTheDocument();
    expect(screen.getByText('AI demo')).toBeInTheDocument();
    expect(screen.getByRole('note', { name: WATERMARK_TEXT })).toBeInTheDocument();
    expect(indexHtml).toContain('<meta name="referrer" content="no-referrer"');
    expect(document.head.querySelector('meta[name="robots"]')).toBeNull();
    expect(api.flags).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(refreshSpy).not.toHaveBeenCalled();
    demo.unmount();

    fetchMock.mockClear();
    const search = `?flags=${BOTH}`;
    at(`/demo/gallery/${GALLERY_PREVIEW_TOKEN}${search}`);
    const gallery = render(<GalleryGate route={{ token: GALLERY_PREVIEW_TOKEN, screen: 'index' }} />);
    const entry = await screen.findByRole('link', { name: 'Try it live' });
    expect(entry).toHaveAttribute('href', liveChatHref(search));
    expect(fetchMock).not.toHaveBeenCalled();
    expect(refreshSpy).not.toHaveBeenCalled();
    gallery.unmount();
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
    expect(container.querySelector('.live-chat-earlier')).toBeNull();
    expect(screen.queryByText('Earlier suggestions')).not.toBeInTheDocument();
    expect(container.querySelector('.live-chat-chip-row > [data-chip="chip_emergency"]')).toBeNull();
    expect(container.querySelectorAll('.live-chat-chip-row > .live-chat-chip')).toHaveLength(4);
    expect(screen.getByText(DISCLOSURE)).toBeInTheDocument();
    expect(screen.getByText(BANNER)).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Can someone come out Tuesday?' }));
    expect(await screen.findByText(SLOTS_LABEL)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /Tuesday 9:00 AM/ }));
    expect(screen.getByText('In the live version this would book the slot.')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'How much for a new furnace?' }));
    expect(await screen.findByText(DECLINE_PRICE)).toBeInTheDocument();
    expect(container.querySelector('.live-chat-thread').textContent).not.toMatch(/\$\d/);

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
    expect(liveChatRouteFromPath(`/demo/prototype/${'a'.repeat(43)}`)).toBeNull();
    expect(prototypeChatFromPath('/demo/live-chat')).toBeNull();
    expect(prototypeChatFromPath(`/demo/prototype/${'a'.repeat(43)}`)).toEqual({
      token: 'a'.repeat(43),
      screen: 'prototype-chat',
    });
    expect(prototypeChatFromPath(`/demo/prototype/${'a'.repeat(43)}/`)).toEqual({
      token: 'a'.repeat(43),
      screen: 'prototype-chat',
    });
    expect(prototypeChatFromPath(`/demo/prototype/${'a'.repeat(42)}`)).toEqual({ token: '', malformed: true });

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
    const phoneRules = css.match(/\.live-chat-phone \{[^}]*\}/g) || [];
    expect(phoneRules.length).toBeGreaterThan(0);
    for (const rule of phoneRules) expect(rule).not.toMatch(/100dvh\s*-\s*\d+px/);
    expect(phoneRules[0]).toContain('display: flex');
    expect(phoneRules[0]).toContain('flex-direction: column');
    expect(phoneRules[0]).toContain('height: calc(100vh - 8.75rem)');
    expect(phoneRules[0]).toContain('height: calc(100dvh - 8.75rem)');
    expect(phoneRules[0]).toContain('min-height: 0');
    expect(phoneRules[0]).toContain('max-height: calc(100dvh - 8.75rem)');
    expect(phoneRules[0]).toContain('overflow: hidden');
    const threadRule = css.slice(css.indexOf('.live-chat-thread {'), css.indexOf('.live-chat-dock'));
    expect(threadRule).toContain('flex: 1 1 auto');
    expect(threadRule).toContain('min-height: 0');
    const outRule = css.slice(css.indexOf('.live-chat-bubble.is-out {'), css.indexOf('.live-chat-chips'));
    expect(outRule).toContain('background: var(--juniper)');
    expect(outRule).not.toContain('proto-accent');
    expect(css).toMatch(/\.live-chat-input:disabled\s*\{[^}]*background:\s*#E4EBE8/);
    expect(css).toMatch(/\.live-chat-chip:disabled,\s*\.live-chat-send:disabled,\s*\.live-chat-chip:disabled:hover,\s*\.live-chat-send:disabled:hover\s*\{[^}]*cursor:\s*not-allowed/);
    expect(css).toMatch(/\.live-chat-chip:disabled,\s*\.live-chat-send:disabled,\s*\.live-chat-chip:disabled:hover,\s*\.live-chat-send:disabled:hover\s*\{[^}]*background:\s*#E4EBE8/);
    expect(css).toMatch(/\.live-chat-chip:disabled,\s*\.live-chat-send:disabled,\s*\.live-chat-chip:disabled:hover,\s*\.live-chat-send:disabled:hover\s*\{[^}]*color:\s*#1E2A2F/);
    expect(threadRule).toContain('overflow-y: auto');
    expect(threadRule).not.toContain('42dvh');
    expect(css).toMatch(/\.live-chat-chip \{[^}]*border-color:\s*#3E4C4F/);
    expect(css).toMatch(/\.live-chat-chip-row \{[^}]*flex-wrap:\s*nowrap/);
    expect(css).toMatch(/\.live-chat-chip-row \{[^}]*overflow-x:\s*auto/);
    expect(css).toContain('mask-image: linear-gradient(to right');
    expect(BANNER_SUMMARY).toBe('Sample by FlowForward · not affiliated · no real bookings · Details');
  });

  function runtimeLocation(hostname, search) {
    return {
      protocol: hostname === 'localhost' ? 'http:' : 'https:',
      port: hostname === 'localhost' ? '5173' : '',
      hostname,
      search,
    };
  }

  it('keeps the route not-found on a production build, and opens it for preview and dev', async () => {
    const hostname = 'flowforward-engine-abc123-turk11.vercel.app';
    const search = `?flags=${BOTH}`;
    for (const env of [{ DEV: false, VERCEL_ENV: 'production' }, { DEV: false, VERCEL_ENV: '' }]) {
      window.sessionStorage.clear();
      _setFlagRuntimeForTests({ env, location: runtimeLocation(hostname, search) });
      const closed = render(<LiveChatGate />);
      expect(await screen.findByRole('heading', { name: 'Page not found' })).toBeInTheDocument();
      expect(screen.queryByText(DISCLOSURE)).not.toBeInTheDocument();
      expect(chatCalls(fetchMock)).toEqual([]);
      closed.unmount();
      fetchMock.mockClear();
    }

    window.sessionStorage.clear();
    _setFlagRuntimeForTests({
      env: { DEV: false, VERCEL_ENV: 'preview' },
      location: runtimeLocation(hostname, search),
    });
    const preview = render(<LiveChatGate />);
    expect(await screen.findByText(DISCLOSURE)).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
    preview.unmount();

    window.sessionStorage.clear();
    _setFlagRuntimeForTests({
      env: { DEV: true, VERCEL_ENV: '' },
      location: runtimeLocation('localhost', search),
    });
    const dev = render(<LiveChatGate />);
    expect(await screen.findByText(DISCLOSURE)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: BANNER_SUMMARY })).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
    dev.unmount();
    expect(chatCalls(fetchMock)).toEqual([]);
  });

  it('scrolls to the latest reply and the typing line, instantly when motion is reduced', async () => {
    const user = userEvent.setup();
    const { container } = render(<LiveChatDemo />);
    const thread = container.querySelector('.live-chat-thread');
    const calls = [];
    thread.scrollTo = (options) => { calls.push(options); };
    const original = Element.prototype.getBoundingClientRect;
    const rectFor = (top, height) => ({
      x: 0, y: top, top, left: 0, bottom: top + height, right: 120, width: 120, height, toJSON() {},
    });
    const rects = vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function mockRect() {
      if (this.classList?.contains('live-chat-typing')) return rectFor(640, 24);
      if (this.classList?.contains('live-chat-tool')) return rectFor(900, 80);
      if (this.classList?.contains('live-chat-failed')) return rectFor(700, 48);
      if (this.classList?.contains('live-chat-thread')) return rectFor(0, 200);
      if (this.classList?.contains('live-chat-bubble') && this.closest('.live-chat-turn')) return rectFor(480, 40);
      return original.call(this);
    });

    try {
      await user.click(screen.getByRole('button', { name: 'My water heater is leaking all over the garage' }));
      expect(await screen.findByText('Typing…')).toBeInTheDocument();
      expect(calls.some((call) => call.top === 464 && call.behavior === 'smooth')).toBe(true);
      expect(await screen.findByText(/marked this sample lead as an emergency/)).toBeInTheDocument();
      expect(calls.at(-1)).toMatchObject({ top: 320, behavior: 'smooth' });
      expect(calls.some((call) => call.top === 900)).toBe(false);

      calls.length = 0;
      await user.type(screen.getByLabelText('Text the business'), 'are you a bot?');
      await user.click(screen.getByRole('button', { name: 'Send' }));
      expect(await screen.findByText('Typing…')).toBeInTheDocument();
      expect(calls.some((call) => call.top === 464 && call.behavior === 'smooth')).toBe(true);
      expect(await screen.findByText(IDENTITY_REPLY)).toBeInTheDocument();
      expect(calls.at(-1)).toMatchObject({ top: 320, behavior: 'smooth' });

      window.matchMedia = vi.fn().mockImplementation((query) => ({
        matches: String(query).includes('prefers-reduced-motion'),
        media: query,
        addEventListener() {},
        removeEventListener() {},
        addListener() {},
        removeListener() {},
        dispatchEvent() { return false; },
      }));
      calls.length = 0;
      await user.click(screen.getByRole('button', { name: 'How much for a new furnace?' }));
      expect(await screen.findByText('Typing…')).toBeInTheDocument();
      expect(calls.some((call) => call.behavior === 'auto')).toBe(true);
      expect(calls.some((call) => call.behavior === 'smooth')).toBe(false);
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      rects.mockRestore();
    }
  }, 20000);

  it('does not call fetch from the live chat import graph', () => {
    const files = readdirSync(here).filter((name) => (name.endsWith('.js') || name.endsWith('.jsx')) && !name.endsWith('.test.jsx'));
    expect(files.length).toBeGreaterThan(0);
    const seen = new Set();
    for (const name of files) walkImports(path.join(here, name), seen);
    const names = [...seen].map((file) => path.basename(file));
    expect(names).toContain('LiveChatDemo.jsx');
    expect(names).toContain('fixture.js');
    expect(names).toContain('public-client.js');
    expect(names).not.toContain('api.js');
    expect(names).not.toContain('remote-flags.js');
    for (const file of seen) {
      const text = readFileSync(file, 'utf8');
      const base = path.basename(file);
      if (base !== 'public-client.js') expect(text, file).not.toMatch(/\bfetch\s*\(/);
      expect(text, file).not.toMatch(/x-api-key/i);
      expect(text, file).not.toMatch(/from ['"][^'"]*\/api(?:\.js)?['"]/);
      expect(text, file).not.toMatch(/from ['"][^'"]*remote-flags(?:\.js)?['"]/);
      expect(text, file).not.toMatch(/anthropic|googleapis|twilio|sendMail|nodemailer/i);
    }
    const client = readFileSync(path.join(here, 'public-client.js'), 'utf8');
    expect(client).toMatch(/\bfetch\s*\(/);
    expect(client).toMatch(/credentials:\s*'omit'/);
  });
});
