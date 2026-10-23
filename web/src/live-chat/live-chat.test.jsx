import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { api } from '../api';
import { WATERMARK_TEXT } from '../components/PrototypeWatermark';
import GalleryGate from '../prototypes/GalleryGate';
import { GALLERY_PREVIEW_TOKEN } from '../prototypes/route';
import LiveChatDemo from './LiveChatDemo';
import LiveChatGate from './LiveChatGate';
import {
  DECLINE_PRICE,
  FALLBACK_REPLY,
  HANDOFF_LINE,
  IDENTITY_REPLY,
  SAMPLE_BUSINESS,
  SAMPLE_CUSTOMER,
  SAMPLE_FACTS,
  SLOTS_LABEL,
  affiliationBanner,
  afterHoursNotice,
  capMessage,
  chipsFor,
  disclosureText,
  messageCodePoints,
} from './fixture.js';
import { liveChatHref, liveChatRouteFromPath } from './route.js';
import { respond } from './respond.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const css = readFileSync(path.join(here, '../styles.css'), 'utf8');
const DISCLOSURE = disclosureText(SAMPLE_BUSINESS, SAMPLE_FACTS.phone);
const BANNER = affiliationBanner(SAMPLE_BUSINESS);
const AFTER_HOURS = "It's 8:12 PM. Your office is closed. The AI still answered.";
const BANNED = ['right now', 'immediately', 'today', 'same day', 'same-day', 'asap', 'on the way'];

function at(pathAndSearch) {
  window.history.pushState({}, '', pathAndSearch);
}

describe('live chat demo', () => {
  let fetchMock;
  let matchMedia;

  beforeEach(() => {
    fetchMock = vi.fn((...args) => {
      throw new Error(`live chat fetch ${args[0]}`);
    });
    vi.stubGlobal('fetch', fetchMock);
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
    vi.stubGlobal('fetch', () => {
      throw new Error('Tests must not call fetch. The API client is mocked.');
    });
  });

  it('hides the route and the gallery entry when the flag is off', async () => {
    at('/demo/live-chat');
    const closed = render(<LiveChatGate />);
    expect(screen.getByRole('heading', { name: 'Page not found' })).toBeInTheDocument();
    expect(screen.queryByText(DISCLOSURE)).not.toBeInTheDocument();
    expect(screen.queryByText(BANNER)).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Try it live' })).not.toBeInTheDocument();
    expect(screen.queryByText(SAMPLE_BUSINESS)).not.toBeInTheDocument();
    closed.unmount();

    at(`/demo/gallery/${GALLERY_PREVIEW_TOKEN}?flags=FF_PROTOTYPE_GALLERY`);
    render(<GalleryGate route={{ token: GALLERY_PREVIEW_TOKEN, screen: 'index' }} />);
    expect(await screen.findByRole('heading', { name: 'Prototype gallery' })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Try it live' })).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Open call' })).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('opens the fixture demo from the preview flag and shows the gallery entry', async () => {
    at('/demo/live-chat?flags=FF_LIVE_CHAT_DEMO');
    const demo = render(<LiveChatGate />);
    expect(await screen.findByText(DISCLOSURE)).toBeInTheDocument();
    expect(screen.getByText(BANNER)).toBeInTheDocument();
    expect(screen.getByText(AFTER_HOURS)).toBeInTheDocument();
    expect(screen.getByText('AI demo')).toBeInTheDocument();
    expect(screen.getByRole('note', { name: WATERMARK_TEXT })).toBeInTheDocument();
    expect(document.querySelector('meta[name="robots"]')).toHaveAttribute('content', 'noindex, nofollow');
    expect(document.querySelector('meta[name="referrer"]')).toHaveAttribute('content', 'no-referrer');
    expect(api.flags).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
    demo.unmount();

    const search = '?flags=FF_PROTOTYPE_GALLERY,FF_LIVE_CHAT_DEMO';
    at(`/demo/gallery/${GALLERY_PREVIEW_TOKEN}${search}`);
    render(<GalleryGate route={{ token: GALLERY_PREVIEW_TOKEN, screen: 'index' }} />);
    const entry = await screen.findByRole('link', { name: 'Try it live' });
    expect(entry).toHaveAttribute('href', liveChatHref(search));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('renders fixture replies, tool cards, and the owner panel without calling fetch', async () => {
    const user = userEvent.setup();
    const { container } = render(<LiveChatDemo />);
    expect(screen.getByText(DISCLOSURE)).toBeInTheDocument();
    expect(screen.getByText(BANNER)).toBeInTheDocument();
    expect(screen.getByRole('note', { name: WATERMARK_TEXT })).toBeInTheDocument();
    expect(within(screen.getByRole('complementary', { name: 'Owner panel' })).getByRole('heading', { name: 'Lead' }).closest('article')).toHaveTextContent(SAMPLE_CUSTOMER);
    expect(screen.getByRole('heading', { name: 'Urgency' }).closest('article')).toHaveTextContent('normal');
    expect(screen.getByRole('heading', { name: 'Mock alert, not sent' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Request created in your CRM (sample)' })).toBeInTheDocument();
    expect(container.querySelector('a[href^="tel:"], a[href^="mailto:"], a[href^="sms:"]')).toBeNull();

    await user.click(screen.getByRole('button', { name: 'My water heater is leaking all over the garage' }));
    expect(container.querySelector('[data-tool="flag_emergency"]')).not.toBeNull();
    expect(container.querySelector('[data-tool="capture_lead"]')).not.toBeNull();
    expect(container.querySelector('[data-tool="handoff_to_human"]')).toHaveTextContent(HANDOFF_LINE);
    const lead = screen.getByRole('heading', { name: 'Lead' }).closest('article');
    expect(lead).toHaveTextContent(SAMPLE_CUSTOMER);
    expect(lead).toHaveTextContent('Water heater');
    expect(lead).not.toHaveTextContent('leaking');
    expect(screen.getByRole('heading', { name: 'Urgency' }).closest('article')).toHaveTextContent('emergency');
    expect(screen.getByRole('heading', { name: 'Mock alert, not sent' }).closest('article')).toHaveTextContent('Nothing left this page.');
    expect(screen.getByText(DISCLOSURE)).toBeInTheDocument();
    expect(screen.getByText(BANNER)).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Can someone come out Tuesday?' }));
    expect(screen.getByText(SLOTS_LABEL)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /Tuesday 9:00 AM/ }));
    expect(screen.getByText('In the live version this would book the slot.')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'How much for a new furnace?' }));
    expect(screen.getByText(DECLINE_PRICE)).toBeInTheDocument();
    expect(screen.queryByText(/\$\d/)).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Are you open Saturday?' }));
    expect(screen.getByText(/Hours on file are Monday–Friday, 8:00 AM–5:00 PM/)).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Do you service Sample Town?' }));
    expect(screen.getByText('Sample Town is in the service area on file.')).toBeInTheDocument();

    const box = screen.getByLabelText('Text the business');
    await user.type(box, 'are you a human?');
    await user.click(screen.getByRole('button', { name: 'Send' }));
    expect(screen.getByText(IDENTITY_REPLY)).toBeInTheDocument();

    await user.type(box, 'Do you install mini-splits?');
    await user.click(screen.getByRole('button', { name: 'Send' }));
    expect(screen.getByText(FALLBACK_REPLY)).toBeInTheDocument();

    expect(screen.getByText(DISCLOSURE)).toBeInTheDocument();
    expect(screen.getByText(BANNER)).toBeInTheDocument();
    expect(screen.getByRole('note', { name: WATERMARK_TEXT })).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('keeps the disclosure and banner when the business name is hostile markup', () => {
    const hostile = {
      name: '</div><script>alert(1)</script>',
      logoUrl: 'https://prospect.example/logo.png',
      colors: { primary: '#FFFFFF', accent: '#FFFFFF', ink: 'transparent' },
    };
    const { container } = render(<LiveChatDemo brandInput={hostile} />);
    expect(container.querySelector('script')).toBeNull();
    expect(container.querySelector('style')).toBeNull();
    expect(container.textContent).toContain('</div><script>alert(1)</script>');
    expect(container.querySelector('[data-disclosure="true"]').textContent).toContain("I'm an AI receptionist demo");
    expect(container.querySelector('[data-disclosure="true"]').textContent).toContain('</div><script>alert(1)</script>');
    expect(screen.getByText(/Not affiliated with or operated by/)).toBeInTheDocument();
    expect(screen.getByRole('note', { name: WATERMARK_TEXT })).toBeInTheDocument();
    expect(container.querySelector('img')).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('counts code points after NFKC and caps the composer at 500', () => {
    expect(messageCodePoints('👍')).toBe(1);
    expect(messageCodePoints('\uFF11\uFF12')).toBe(2);
    expect(capMessage(`${'a'.repeat(501)}`)).toHaveLength(500);
    expect(capMessage('\uFF11'.repeat(501))).toBe('1'.repeat(500));
    expect(afterHoursNotice(SAMPLE_FACTS)).toBe(AFTER_HOURS);
    expect(afterHoursNotice(SAMPLE_FACTS, new Date('2026-10-21T16:00:00.000Z'))).toBe('');
    expect(disclosureText(SAMPLE_BUSINESS, '')).toContain('please call the business directly.');
    expect(liveChatRouteFromPath('/demo/live-chat')).toEqual({ screen: 'live-chat' });
    expect(liveChatRouteFromPath('/demo/live-chat/extra')).toBeNull();

    for (const chip of chipsFor(SAMPLE_FACTS)) {
      const reply = respond({ facts: SAMPLE_FACTS, message: chip.label, chipId: chip.id });
      expect(reply.source).toBe('fixture');
      for (const phrase of BANNED) expect(reply.text.toLowerCase()).not.toContain(phrase);
    }
    expect(respond({ facts: SAMPLE_FACTS, message: 'are you a bot?' }).text).toBe(IDENTITY_REPLY);

    render(<LiveChatDemo />);
    const box = screen.getByLabelText('Text the business');
    fireEvent.change(box, { target: { value: 'a'.repeat(501) } });
    expect(box).toHaveValue('a'.repeat(500));
    expect(screen.getByText('500 / 500')).toBeInTheDocument();
    fireEvent.change(box, { target: { value: '👍👍' } });
    expect(screen.getByText('2 / 500')).toBeInTheDocument();
    const tap = css.slice(css.indexOf('.live-chat-chip, .live-chat-action, .live-chat-send {'));
    expect(tap.slice(0, 240)).toContain('min-height: 44px');
  });

  it('does not call fetch from the live chat modules', () => {
    const files = readdirSync(here).filter((name) => (name.endsWith('.js') || name.endsWith('.jsx')) && !name.endsWith('.test.jsx'));
    expect(files.length).toBeGreaterThan(0);
    for (const name of files) {
      const text = readFileSync(path.join(here, name), 'utf8');
      expect(text, name).not.toMatch(/\bfetch\s*\(/);
      expect(text, name).not.toMatch(/from ['"][^'"]*\/api(?:\.js)?['"]/);
      expect(text, name).not.toMatch(/anthropic|googleapis|twilio|sendMail|nodemailer/i);
    }
  });
});
