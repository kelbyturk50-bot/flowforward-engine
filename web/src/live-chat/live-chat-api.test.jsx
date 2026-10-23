import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { WATERMARK_TEXT } from '../components/PrototypeWatermark';
import { _setFlagRuntimeForTests } from '../flags';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  INVALID_ERROR,
  LIMIT_NOTICE,
  LINK_LIFETIME,
  LINK_NEXT_STEP,
  PAUSE_LOCKED_MESSAGE,
  PAUSE_MESSAGE,
  TOO_LONG_ERROR,
} from './contract.js';
import { affiliationBanner } from './fixture.js';
import LiveChatGate from './LiveChatGate';
import { parsePublicFlags } from './public-flags.js';

const SESSION = 's'.repeat(43);
const TOKEN = 'p'.repeat(43);
const FLAGS_ON = { FF_PROTOTYPE_GALLERY: true, FF_LIVE_CHAT_DEMO: true };
const WASATCH_BANNER = 'Sample concept built by FlowForward for Wasatch Heating. Not affiliated with or operated by Wasatch Heating. No real bookings are made.';
const WASATCH_DISCLOSURE = "Hi! I'm an AI receptionist demo FlowForward built for Wasatch Heating. I'm not connected to their team. If you're a real customer, please call (801) 555-0101.";
const CANYON_BANNER = 'Sample concept built by FlowForward for Canyon Plumbing. Not affiliated with or operated by Canyon Plumbing. No real bookings are made.';
const CANYON_DISCLOSURE = "Hi! I'm an AI receptionist demo FlowForward built for Canyon Plumbing. I'm not connected to their team. If you're a real customer, please call (801) 555-0102.";

function at(pathAndSearch) {
  window.history.pushState({}, '', pathAndSearch);
}

function jsonResult(status, body) {
  return { status, text: async () => JSON.stringify(body ?? {}) };
}

function wasatch() {
  return {
    slug: 'wasatch-heating',
    business_name: 'Wasatch Heating',
    colors: { primary: '#1b4f72', secondary: '#f4d03f' },
    banner: WASATCH_BANNER,
    disclosure: WASATCH_DISCLOSURE,
    logoUrl: 'https://evil.example/logo.png',
    facts: [
      { field: 'hours', value: 'Monday–Friday, 8:00 AM–5:00 PM' },
      { field: 'service_area', value: 'Salt Lake City, Provo' },
      { field: 'phone', value: '(801) 555-0101' },
    ],
    chips: [
      { id: 'chip_emergency', label: 'My water heater is leaking all over the garage' },
      { id: 'chip_booking', label: 'Can someone come out Tuesday?' },
      { id: 'chip_price', label: 'How much for a new furnace?' },
      { id: 'chip_hours', label: 'Are you open Saturday?' },
      { id: 'chip_area', label: 'Do you service Salt Lake City?' },
    ],
  };
}

function envelope(extra) {
  return {
    watermark: WATERMARK_TEXT,
    banner: WASATCH_BANNER,
    business_name: 'Wasatch Heating',
    colors: { primary: '#1b4f72', secondary: '#f4d03f' },
    ...extra,
  };
}

function stubMatchMedia(matches = false) {
  window.matchMedia = vi.fn().mockImplementation((query) => ({
    matches,
    media: query,
    addEventListener() {},
    removeEventListener() {},
    addListener() {},
    removeListener() {},
    dispatchEvent() { return false; },
  }));
}

describe('live chat public API', () => {
  let fetchMock;
  let matchMedia;

  beforeEach(() => {
    window.sessionStorage.clear();
    localStorage.setItem('ff.apiKey', 'k'.repeat(40));
    localStorage.removeItem('ff.apiUrl');
    at('/demo/live-chat');
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    matchMedia = window.matchMedia;
    stubMatchMedia(false);
  });

  afterEach(() => {
    window.matchMedia = matchMedia;
    localStorage.removeItem('ff.apiKey');
    _setFlagRuntimeForTests(null);
    vi.stubGlobal('fetch', () => {
      throw new Error('Tests must not call fetch. The API client is mocked.');
    });
  });

  function install(handler) {
    fetchMock.mockImplementation(async (url, init = {}) => {
      const names = Object.keys(init.headers || {}).map((name) => name.toLowerCase());
      expect(names).not.toContain('x-api-key');
      expect(names).not.toContain('authorization');
      expect(init.credentials).toBe('omit');
      const path = new URL(String(url), 'http://localhost:3000').pathname;
      const result = await handler(path, init);
      return jsonResult(result.status, result.body);
    });
  }

  function paths() {
    return fetchMock.mock.calls.map((call) => new URL(String(call[0]), 'http://localhost:3000').pathname);
  }

  it('opens the sample demo from public flags and posts session, message, and cta', async () => {
    const user = userEvent.setup();
    const calls = [];
    install(async (path, init) => {
      calls.push({ path, method: init.method, body: init.body ? JSON.parse(init.body) : null });
      if (path === '/api/public/flags') return { status: 200, body: FLAGS_ON };
      if (path === '/api/public/chat/demos') return { status: 200, body: { watermark: WATERMARK_TEXT, demos: [wasatch()] } };
      if (path === '/api/public/chat/demos/wasatch-heating/session') {
        return { status: 201, body: envelope({ sessionId: SESSION, expires_at: '2026-10-23T18:00:00.000Z', disclosure: WASATCH_DISCLOSURE }) };
      }
      if (path === '/api/public/chat/demos/wasatch-heating/message') {
        return {
          status: 200,
          body: envelope({
            text: 'Server marked this sample as an emergency.',
            tools: [{ name: 'flag_emergency', args: { service: 'water_heater', urgency: 'emergency' }, card: 'Flagged as an emergency in the sample.' }],
            slots: [],
            source: 'fixture',
            paused: false,
            pause_message: null,
            sample_lead: { name: 'Sample customer', phone: '(801) 555-0199', service: 'water_heater', urgency: 'emergency' },
          }),
        };
      }
      if (path === '/api/public/chat/demos/wasatch-heating/cta') return { status: 200, body: envelope({ ok: true }) };
      throw new Error(`unexpected ${path}`);
    });
    const { container } = render(<LiveChatGate />);
    expect(await screen.findByRole('heading', { level: 1, name: 'Wasatch Heating' })).toBeInTheDocument();
    expect(screen.getByText(WASATCH_DISCLOSURE)).toBeInTheDocument();
    expect(screen.getByText(WASATCH_BANNER)).toBeInTheDocument();
    expect(screen.getByRole('note', { name: WATERMARK_TEXT })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Do you service Salt Lake City?' })).toBeInTheDocument();
    expect(container.querySelector('img')).toBeNull();
    expect(container.innerHTML).not.toContain('evil.example');
    expect(container.querySelector('.live-chat-title').getAttribute('style')).toMatch(/#F4D03F/i);
    expect(container.querySelector('.live-chat').getAttribute('style')).toBeNull();
    expect(screen.queryByRole('heading', { name: 'Sample Home Services' })).toBeNull();

    await user.click(screen.getByRole('button', { name: 'My water heater is leaking all over the garage' }));
    expect(await screen.findByText('Server marked this sample as an emergency.')).toBeInTheDocument();
    const message = calls.find((call) => call.path.endsWith('/message'));
    expect(message.body).toEqual({
      sessionId: SESSION,
      text: 'My water heater is leaking all over the garage',
      chipId: 'chip_emergency',
    });
    await user.click(screen.getByRole('button', { name: 'Note the emergency' }));
    await waitFor(() => {
      expect(calls.some((call) => call.path.endsWith('/cta') && call.body.sessionId === SESSION)).toBe(true);
    });
  }, 15000);

  it('keeps fixture replies when the preview override is what opened the page', async () => {
    const user = userEvent.setup();
    install(async (path) => {
      if (path === '/api/public/flags') return { status: 200, body: { FF_PROTOTYPE_GALLERY: true, FF_LIVE_CHAT_DEMO: false } };
      throw new Error(`unexpected ${path}`);
    });
    at('/demo/live-chat?flags=FF_PROTOTYPE_GALLERY,FF_LIVE_CHAT_DEMO');
    render(<LiveChatGate />);
    expect(await screen.findByRole('heading', { level: 1, name: 'Sample Home Services' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Are you open Saturday?' }));
    expect(await screen.findByText(/Hours on file are Monday–Friday/)).toBeInTheDocument();
    expect(paths()).toEqual([]);
  }, 15000);

  it('shows not-found when flags are off, malformed, or the API says not_found', async () => {
    install(async (path) => {
      if (path === '/api/public/flags') return { status: 200, body: { FF_PROTOTYPE_GALLERY: false, FF_LIVE_CHAT_DEMO: false } };
      throw new Error(`unexpected ${path}`);
    });
    const off = render(<LiveChatGate />);
    expect(await screen.findByRole('heading', { name: 'Page not found' })).toBeInTheDocument();
    expect(paths()).toEqual(['/api/public/flags']);
    off.unmount();

    fetchMock.mockClear();
    install(async (path) => {
      if (path === '/api/public/flags') return { status: 200, body: { FF_LIVE_CHAT_DEMO: true, FF_PROTOTYPE_GALLERY: true } };
      throw new Error(`unexpected ${path}`);
    });
    const swapped = render(<LiveChatGate />);
    expect(await screen.findByRole('heading', { name: 'Page not found' })).toBeInTheDocument();
    expect(paths().some((path) => path.includes('/chat'))).toBe(false);
    swapped.unmount();

    fetchMock.mockClear();
    at(`/demo/prototype/${'short'}`);
    const malformed = render(<LiveChatGate token="" malformed />);
    expect(await screen.findByRole('heading', { name: 'Page not found' })).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
    malformed.unmount();

    at(`/demo/prototype/${TOKEN}`);
    install(async (path) => {
      if (path === '/api/public/flags') return { status: 200, body: FLAGS_ON };
      if (path === `/api/public/prototypes/${TOKEN}/chat/session`) return { status: 404, body: { error: 'not_found' } };
      throw new Error(`unexpected ${path}`);
    });
    render(<LiveChatGate token={TOKEN} />);
    expect(await screen.findByRole('heading', { name: 'Page not found' })).toBeInTheDocument();
    expect(screen.getByRole('note', { name: WATERMARK_TEXT })).toBeInTheDocument();
  });

  it('shows an expired prototype link with the Denver date and no composer', async () => {
    at(`/demo/prototype/${TOKEN}`);
    install(async (path) => {
      if (path === '/api/public/flags') return { status: 200, body: FLAGS_ON };
      if (path === `/api/public/prototypes/${TOKEN}/chat/session`) {
        return { status: 410, body: { error: 'link_expired', expires_at: '2026-10-24T05:30:00.000Z' } };
      }
      throw new Error(`unexpected ${path}`);
    });
    render(<LiveChatGate token={TOKEN} />);
    expect(await screen.findByRole('heading', { name: 'This demo link has expired' })).toBeInTheDocument();
    expect(screen.getByText(LINK_LIFETIME)).toBeInTheDocument();
    expect(screen.getByText('This one expired on Oct 23, 2026, 11:30 PM MT.')).toBeInTheDocument();
    expect(screen.getByText(LINK_NEXT_STEP)).toBeInTheDocument();
    expect(screen.getByText(WATERMARK_TEXT)).toBeInTheDocument();
    expect(screen.queryByLabelText('Text the business')).toBeNull();
    const store = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '../../../src/prototypes/store.js'), 'utf8');
    expect(store).toContain("INTERVAL '336 hours'");
    expect(LINK_LIFETIME).toContain('14 days');
  });

  it('disables the composer for a paused demo and a reached limit', async () => {
    install(async (path) => {
      if (path === '/api/public/flags') return { status: 200, body: FLAGS_ON };
      if (path === '/api/public/chat/demos') return { status: 200, body: { watermark: WATERMARK_TEXT, demos: [wasatch()] } };
      if (path.endsWith('/session')) {
        return { status: 503, body: envelope({ error: 'demo_paused', pause_message: PAUSE_MESSAGE, paused: true }) };
      }
      throw new Error(`unexpected ${path}`);
    });
    const paused = render(<LiveChatGate />);
    expect(await screen.findByText(PAUSE_LOCKED_MESSAGE)).toBeInTheDocument();
    expect(screen.queryByText(PAUSE_MESSAGE)).toBeNull();
    expect(screen.getByLabelText('Text the business')).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled();
    expect(screen.queryByRole('group', { name: 'Suggestions' })).toBeNull();
    paused.unmount();

    install(async (path) => {
      if (path === '/api/public/flags') return { status: 200, body: FLAGS_ON };
      if (path === '/api/public/chat/demos') return { status: 200, body: { watermark: WATERMARK_TEXT, demos: [wasatch()] } };
      if (path.endsWith('/session')) {
        return { status: 429, body: envelope({ error: 'demo_limit', message: 'Demo limit reached' }) };
      }
      throw new Error(`unexpected ${path}`);
    });
    render(<LiveChatGate />);
    expect(await screen.findByText(LIMIT_NOTICE)).toBeInTheDocument();
    expect(screen.getByLabelText('Text the business')).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled();
    expect(screen.queryByRole('group', { name: 'Suggestions' })).toBeNull();
  });

  it('keeps sample replies going when a turn is paused, and keeps the draft on 400 and 413', async () => {
    const user = userEvent.setup();
    let messageStatus = 200;
    install(async (path) => {
      if (path === '/api/public/flags') return { status: 200, body: FLAGS_ON };
      if (path === '/api/public/chat/demos') return { status: 200, body: { watermark: WATERMARK_TEXT, demos: [wasatch()] } };
      if (path.endsWith('/session')) {
        return { status: 201, body: envelope({ sessionId: SESSION, disclosure: WASATCH_DISCLOSURE }) };
      }
      if (path.endsWith('/message')) {
        if (messageStatus === 400) return { status: 400, body: envelope({ error: 'invalid_body' }) };
        if (messageStatus === 413) return { status: 413, body: envelope({ error: 'message_too_long' }) };
        return {
          status: 200,
          body: envelope({
            text: 'Here is a sample reply while the live model rests.',
            tools: [],
            slots: [],
            source: 'fixture',
            paused: true,
            pause_message: PAUSE_MESSAGE,
            sample_lead: { name: 'Sample customer', phone: '(801) 555-0199', service: 'general', urgency: 'normal' },
          }),
        };
      }
      throw new Error(`unexpected ${path}`);
    });
    const view = render(<LiveChatGate />);
    const box = await screen.findByLabelText('Text the business');
    await user.type(box, 'Are you open Saturday?');
    await user.click(screen.getByRole('button', { name: 'Send' }));
    expect(await screen.findByText('Here is a sample reply while the live model rests.')).toBeInTheDocument();
    expect(screen.getByText(PAUSE_MESSAGE)).toBeInTheDocument();
    expect(screen.getByLabelText('Text the business')).toBeEnabled();
    expect(screen.getByRole('group', { name: 'Suggestions' })).toBeInTheDocument();

    messageStatus = 400;
    await user.type(box, 'keep this draft');
    await user.click(screen.getByRole('button', { name: 'Send' }));
    expect(await screen.findByText(INVALID_ERROR)).toBeInTheDocument();
    expect(box).toHaveValue('keep this draft');

    messageStatus = 413;
    await user.clear(box);
    await user.type(box, 'still here');
    await user.click(screen.getByRole('button', { name: 'Send' }));
    expect(await screen.findByText(TOO_LONG_ERROR)).toBeInTheDocument();
    expect(box).toHaveValue('still here');
    view.unmount();
  }, 15000);

  it('retries a server or network failure and opens a prototype token chat', async () => {
    const user = userEvent.setup();
    let fail = true;
    install(async (path) => {
      if (path === '/api/public/flags') return { status: 200, body: FLAGS_ON };
      if (path === '/api/public/chat/demos') return { status: 200, body: { watermark: WATERMARK_TEXT, demos: [wasatch()] } };
      if (path.endsWith('/session')) {
        return { status: 201, body: envelope({ sessionId: SESSION, disclosure: WASATCH_DISCLOSURE }) };
      }
      if (path.endsWith('/message')) {
        if (fail) {
          fail = false;
          return { status: 500, body: envelope({ error: 'server_error' }) };
        }
        return {
          status: 200,
          body: envelope({
            text: 'Recovered sample reply.',
            tools: [],
            slots: [],
            source: 'fixture',
            paused: false,
            pause_message: null,
            sample_lead: { name: 'Sample customer', phone: '(801) 555-0199', service: 'general', urgency: 'normal' },
          }),
        };
      }
      throw new Error(`unexpected ${path}`);
    });
    const sample = render(<LiveChatGate />);
    const box = await screen.findByLabelText('Text the business');
    await user.type(box, 'hello');
    await user.click(screen.getByRole('button', { name: 'Send' }));
    expect(await screen.findByRole('alert')).toHaveTextContent("This sample reply didn't load.");
    await user.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText('Recovered sample reply.')).toBeInTheDocument();
    sample.unmount();

    at(`/demo/prototype/${TOKEN}`);
    install(async (path) => {
      if (path === '/api/public/flags') return { status: 200, body: FLAGS_ON };
      if (path === `/api/public/prototypes/${TOKEN}/chat/session`) {
        return {
          status: 201,
          body: {
            watermark: WATERMARK_TEXT,
            banner: CANYON_BANNER,
            business_name: 'Canyon Plumbing',
            colors: { primary: '#0e4d3a', secondary: '#e8f0ec' },
            sessionId: SESSION,
            disclosure: CANYON_DISCLOSURE,
          },
        };
      }
      if (path === `/api/public/prototypes/${TOKEN}/chat/message`) {
        return {
          status: 200,
          body: {
            watermark: WATERMARK_TEXT,
            banner: CANYON_BANNER,
            business_name: 'Canyon Plumbing',
            colors: { primary: '#0e4d3a', secondary: '#e8f0ec' },
            text: 'Canyon sample reply.',
            tools: [],
            slots: [],
            source: 'fixture',
            paused: false,
            pause_message: null,
            sample_lead: { name: 'Sample customer', phone: '(801) 555-0199', service: 'general', urgency: 'normal' },
          },
        };
      }
      throw new Error(`unexpected ${path}`);
    });
    const { container } = render(<LiveChatGate token={TOKEN} />);
    expect(await screen.findByRole('heading', { level: 1, name: 'Canyon Plumbing' })).toBeInTheDocument();
    expect(screen.getByText(CANYON_DISCLOSURE)).toBeInTheDocument();
    expect(screen.getByText(CANYON_BANNER)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Do you service this area?' })).toBeInTheDocument();
    expect(container.querySelector('img')).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Do you service this area?' }));
    expect(await screen.findByText('Canyon sample reply.')).toBeInTheDocument();
    expect(paths().some((path) => path === `/api/public/prototypes/${TOKEN}/chat/message`)).toBe(true);
  }, 15000);

  it('keeps a token URL on not-found when the preview override is on and real flags are off', async () => {
    at(`/demo/prototype/${TOKEN}?flags=FF_PROTOTYPE_GALLERY,FF_LIVE_CHAT_DEMO`);
    install(async (path) => {
      if (path === '/api/public/flags') {
        return { status: 200, body: { FF_PROTOTYPE_GALLERY: false, FF_LIVE_CHAT_DEMO: false } };
      }
      throw new Error(`unexpected ${path}`);
    });
    render(<LiveChatGate token={TOKEN} />);
    expect(await screen.findByRole('heading', { name: 'Page not found' })).toBeInTheDocument();
    expect(screen.queryByText(/I'm an AI receptionist demo/)).toBeNull();
    expect(paths().some((path) => path.includes('/chat/'))).toBe(false);
  });

  it('stays not-found when the gallery flag is off, on the sample route and the token route', async () => {
    const galleryOff = { FF_PROTOTYPE_GALLERY: false, FF_LIVE_CHAT_DEMO: true };
    install(async (path) => {
      if (path === '/api/public/flags') return { status: 200, body: galleryOff };
      throw new Error(`unexpected ${path}`);
    });
    const sample = render(<LiveChatGate />);
    expect(await screen.findByRole('heading', { name: 'Page not found' })).toBeInTheDocument();
    expect(paths().some((path) => path.includes('/chat/'))).toBe(false);
    sample.unmount();

    fetchMock.mockClear();
    at(`/demo/prototype/${TOKEN}`);
    install(async (path) => {
      if (path === '/api/public/flags') return { status: 200, body: galleryOff };
      throw new Error(`unexpected ${path}`);
    });
    render(<LiveChatGate token={TOKEN} />);
    expect(await screen.findByRole('heading', { name: 'Page not found' })).toBeInTheDocument();
    expect(paths().some((path) => path.includes('/chat/'))).toBe(false);
  });

  it('stays not-found when the chat flag is off and there is no preview override', async () => {
    const chatOff = { FF_PROTOTYPE_GALLERY: true, FF_LIVE_CHAT_DEMO: false };
    at('/demo/live-chat');
    install(async (path) => {
      if (path === '/api/public/flags') return { status: 200, body: chatOff };
      throw new Error(`unexpected ${path}`);
    });
    const sample = render(<LiveChatGate />);
    expect(await screen.findByRole('heading', { name: 'Page not found' })).toBeInTheDocument();
    expect(screen.getByRole('note', { name: WATERMARK_TEXT })).toBeInTheDocument();
    expect(screen.queryByText(/I'm an AI receptionist demo/)).toBeNull();
    expect(paths()).toEqual(['/api/public/flags']);
    sample.unmount();

    fetchMock.mockClear();
    at(`/demo/prototype/${TOKEN}`);
    install(async (path) => {
      if (path === '/api/public/flags') return { status: 200, body: chatOff };
      throw new Error(`unexpected ${path}`);
    });
    render(<LiveChatGate token={TOKEN} />);
    expect(await screen.findByRole('heading', { name: 'Page not found' })).toBeInTheDocument();
    expect(screen.getByRole('note', { name: WATERMARK_TEXT })).toBeInTheDocument();
    expect(paths()).toEqual(['/api/public/flags']);
  });

  it('ignores an API watermark and uses the contract banner when the banner is blank or missing', async () => {
    const evil = 'EVIL WATERMARK FROM THE API';
    install(async (path) => {
      if (path === '/api/public/flags') return { status: 200, body: FLAGS_ON };
      if (path === '/api/public/chat/demos') {
        return { status: 200, body: { watermark: evil, demos: [{ ...wasatch(), banner: '' }] } };
      }
      if (path.endsWith('/session')) {
        return { status: 201, body: envelope({ sessionId: SESSION, disclosure: WASATCH_DISCLOSURE, watermark: evil, banner: '   ' }) };
      }
      throw new Error(`unexpected ${path}`);
    });
    const blank = render(<LiveChatGate />);
    expect(await screen.findByRole('note', { name: WATERMARK_TEXT })).toBeInTheDocument();
    expect(screen.queryByText(evil)).toBeNull();
    expect(screen.getByText(affiliationBanner('Wasatch Heating'))).toBeInTheDocument();
    blank.unmount();

    const listed = wasatch();
    delete listed.banner;
    install(async (path) => {
      if (path === '/api/public/flags') return { status: 200, body: FLAGS_ON };
      if (path === '/api/public/chat/demos') {
        return { status: 200, body: { watermark: evil, demos: [listed] } };
      }
      if (path.endsWith('/session')) {
        return { status: 201, body: envelope({ sessionId: SESSION, disclosure: WASATCH_DISCLOSURE, watermark: evil }) };
      }
      throw new Error(`unexpected ${path}`);
    });
    render(<LiveChatGate />);
    expect(await screen.findByRole('note', { name: WATERMARK_TEXT })).toBeInTheDocument();
    expect(screen.queryByText(evil)).toBeNull();
    expect(screen.getByText(affiliationBanner('Wasatch Heating'))).toBeInTheDocument();
  });

  it('rejects a public flags payload with an extra key', () => {
    expect(parsePublicFlags({ ...FLAGS_ON, extra: true })).toBeNull();
  });

  it('treats a non-200 flags response as closed even when the body lists both flags', async () => {
    install(async (path) => {
      if (path === '/api/public/flags') return { status: 404, body: FLAGS_ON };
      throw new Error(`unexpected ${path}`);
    });
    render(<LiveChatGate />);
    expect(await screen.findByRole('heading', { name: 'Page not found' })).toBeInTheDocument();
    expect(paths().some((path) => path.includes('/chat/'))).toBe(false);
  });

  it('keeps the sent bubble when a later message hits the limit', async () => {
    const user = userEvent.setup();
    install(async (path) => {
      if (path === '/api/public/flags') return { status: 200, body: FLAGS_ON };
      if (path === '/api/public/chat/demos') return { status: 200, body: { watermark: WATERMARK_TEXT, demos: [wasatch()] } };
      if (path.endsWith('/session')) {
        return { status: 201, body: envelope({ sessionId: SESSION, disclosure: WASATCH_DISCLOSURE }) };
      }
      if (path.endsWith('/message')) return { status: 429, body: envelope({ error: 'demo_limit', message: 'Demo limit reached' }) };
      throw new Error(`unexpected ${path}`);
    });
    render(<LiveChatGate />);
    const box = await screen.findByLabelText('Text the business');
    expect(screen.getByRole('group', { name: 'Suggestions' })).toBeInTheDocument();
    await user.type(box, 'Are you open Saturday?');
    await user.click(screen.getByRole('button', { name: 'Send' }));
    expect(await screen.findByText(LIMIT_NOTICE)).toBeInTheDocument();
    expect(document.querySelector('.live-chat-bubble.is-out')).toHaveTextContent('Are you open Saturday?');
    expect(screen.getByLabelText('Text the business')).toHaveValue('');
    expect(screen.getByLabelText('Text the business')).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled();
    expect(screen.queryByRole('group', { name: 'Suggestions' })).toBeNull();
  });

  it('keeps the sent bubble when a later message gets a 503 pause', async () => {
    const user = userEvent.setup();
    install(async (path) => {
      if (path === '/api/public/flags') return { status: 200, body: FLAGS_ON };
      if (path === '/api/public/chat/demos') return { status: 200, body: { watermark: WATERMARK_TEXT, demos: [wasatch()] } };
      if (path.endsWith('/session')) {
        return { status: 201, body: envelope({ sessionId: SESSION, disclosure: WASATCH_DISCLOSURE }) };
      }
      if (path.endsWith('/message')) {
        return { status: 503, body: envelope({ error: 'demo_paused', pause_message: PAUSE_MESSAGE, paused: true }) };
      }
      throw new Error(`unexpected ${path}`);
    });
    render(<LiveChatGate />);
    const box = await screen.findByLabelText('Text the business');
    expect(screen.getByRole('group', { name: 'Suggestions' })).toBeInTheDocument();
    await user.type(box, 'Are you open Saturday?');
    await user.click(screen.getByRole('button', { name: 'Send' }));
    expect(await screen.findByText(PAUSE_LOCKED_MESSAGE)).toBeInTheDocument();
    expect(screen.queryByText(PAUSE_MESSAGE)).toBeNull();
    expect(document.querySelector('.live-chat-bubble.is-out')).toHaveTextContent('Are you open Saturday?');
    expect(screen.getByLabelText('Text the business')).toHaveValue('');
    expect(screen.getByLabelText('Text the business')).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled();
    expect(screen.queryByRole('group', { name: 'Suggestions' })).toBeNull();
  });

  it('ignores a saved API address and never sends credentials', async () => {
    localStorage.setItem('ff.apiUrl', 'https://evil.example');
    const seen = [];
    install(async (path, init) => {
      seen.push({ url: String(fetchMock.mock.calls.at(-1)[0]), credentials: init.credentials });
      if (path === '/api/public/flags') return { status: 200, body: FLAGS_ON };
      if (path === '/api/public/chat/demos') return { status: 200, body: { watermark: WATERMARK_TEXT, demos: [wasatch()] } };
      if (path.endsWith('/session')) {
        return { status: 201, body: envelope({ sessionId: SESSION, disclosure: WASATCH_DISCLOSURE }) };
      }
      throw new Error(`unexpected ${path}`);
    });
    render(<LiveChatGate />);
    expect(await screen.findByText(WASATCH_DISCLOSURE)).toBeInTheDocument();
    expect(seen.length).toBeGreaterThan(0);
    for (const call of seen) {
      expect(call.url.startsWith('http://localhost:3000')).toBe(true);
      expect(call.url).not.toContain('evil.example');
      expect(call.credentials).toBe('omit');
    }
    const source = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'public-client.js'), 'utf8');
    expect(source).toContain("credentials: 'omit'");
    expect(source).not.toMatch(/credentials:\s*['"]include['"]/);
    expect(source).not.toMatch(/credentials:\s*['"]same-origin['"]/);
    expect(source).not.toContain('ff.apiUrl');
    expect(source).not.toContain('*');
    expect(source).not.toMatch(/x-api-key/i);
  });
});
