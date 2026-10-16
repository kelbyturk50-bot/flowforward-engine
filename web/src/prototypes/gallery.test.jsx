import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import PrototypeWatermark, { ACTION_TOAST, FOOTER_LEAD, WATERMARK_TEXT } from '../components/PrototypeWatermark';
import GalleryGate from './GalleryGate';
import { GALLERY_PREVIEW_TOKEN, galleryHref, galleryRouteFromPath, galleryTokenOk } from './route';

const TOKEN = GALLERY_PREVIEW_TOKEN;
const webRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

function at(pathAndSearch) {
  window.history.pushState({}, '', pathAndSearch);
}

function paint(value) {
  return String(value || '').replace(/\s/g, '').toLowerCase();
}

function expectFooter(container, name) {
  const footer = container.querySelector('.prototype-footer');
  expect(footer).not.toBeNull();
  expect(footer.querySelector('.prototype-business').textContent).toBe(name);
  expect(footer.querySelector('.prototype-sample').textContent).toBe('Sample');
  const sentence = footer.cloneNode(true);
  sentence.querySelector('.prototype-sample').remove();
  expect(sentence.textContent).toBe(`${FOOTER_LEAD}${name}.`);
}

function expectRibbon(container) {
  const ribbon = container.querySelector('[data-prototype-ribbon]');
  const scroll = container.querySelector('.prototype-scroll');
  expect(ribbon).not.toBeNull();
  expect(ribbon.textContent).toBe(WATERMARK_TEXT);
  expect(ribbon.querySelector('button')).toBeNull();
  expect(scroll.contains(ribbon)).toBe(false);
  expect(scroll.contains(container.querySelector('.prototype-screen'))).toBe(true);
  expect(ribbon.style.position).toBe('sticky');
  expect(ribbon.style.top).toBe('0px');
  expect(ribbon.getAttribute('role')).toBe('note');
  expect(paint(ribbon.style.backgroundColor)).toMatch(/#1e2a2f|rgb\(30,42,47\)/);
  expect(paint(ribbon.style.color)).toMatch(/#f3f6f5|rgb\(243,246,245\)/);
  expect(ribbon.style.fontWeight).toBe('600');
  expect(ribbon.style.fontSize).toBe('14px');
  expect(ribbon.style.fontFamily.toLowerCase()).toContain('barlow');
  expect(ribbon.style.fontFamily.toLowerCase()).toContain('system-ui');
  expect(ribbon.getAttribute('style')).toContain('safe-area-inset-top');
  expect(ribbon.getAttribute('style')).toContain('32px');
  expect(ribbon.getAttribute('style')).not.toContain('var(');
  expect(ribbon.style.getPropertyPriority('background-color')).toBe('important');
  expect(ribbon.style.getPropertyPriority('color')).toBe('important');
  const tile = container.querySelector('[data-prototype-tile]');
  expect(container.querySelector('.prototype-screen').contains(ribbon)).toBe(false);
  expect(container.querySelector('.prototype-screen').contains(tile)).toBe(true);
  expect(tile.style.pointerEvents).toBe('none');
  expect(tile.style.zIndex).toBe('1');
  expect(tile.getAttribute('style')).toContain('0.05');
  expect(tile.getAttribute('style')).toContain('PROTOTYPE');
  expect(container.querySelector('.prototype-brand-name .prototype-sample').textContent).toBe('Sample');
  return ribbon;
}

describe('prototype gallery', () => {
  let fetchMock;
  let xhrMock;
  let originalXhr;
  let calls;
  let downloads;
  let createObjectURL;
  let anchorClick;
  let matchMedia;

  beforeEach(() => {
    calls = { fetch: 0, xhr: 0 };
    originalXhr = window.XMLHttpRequest;
    fetchMock = vi.fn((...args) => {
      calls.fetch += 1;
      throw new Error(`prototype fetch ${args[0]}`);
    });
    xhrMock = vi.fn();
    class RecordingXHR {
      open(...args) { calls.xhr += 1; xhrMock('open', ...args); }
      send(...args) { calls.xhr += 1; xhrMock('send', ...args); }
      setRequestHeader() {}
      addEventListener() {}
      abort() {}
    }
    vi.stubGlobal('fetch', fetchMock);
    vi.stubGlobal('XMLHttpRequest', RecordingXHR);
    downloads = [];
    createObjectURL = vi.fn(() => 'blob:prototype-gallery');
    vi.stubGlobal('URL', Object.assign(URL, {
      createObjectURL,
      revokeObjectURL: vi.fn(),
    }));
    anchorClick = HTMLAnchorElement.prototype.click;
    HTMLAnchorElement.prototype.click = function click() {
      if (this.download) downloads.push({ download: this.download, href: this.href });
    };
    matchMedia = window.matchMedia;
    window.matchMedia = vi.fn().mockImplementation((query) => ({
      matches: String(query).includes('prefers-reduced-motion'),
      media: query,
      addEventListener() {},
      removeEventListener() {},
      addListener() {},
      removeListener() {},
      dispatchEvent() { return false; },
    }));
  });

  afterEach(() => {
    HTMLAnchorElement.prototype.click = anchorClick;
    window.matchMedia = matchMedia;
    vi.stubGlobal('XMLHttpRequest', originalXhr);
    vi.stubGlobal('fetch', () => {
      throw new Error('Tests must not call fetch. The API client is mocked.');
    });
  });

  it('shows not-found when the gallery flag is off', () => {
    at(`/demo/gallery/${TOKEN}`);
    render(<GalleryGate route={{ token: TOKEN, screen: 'index' }} />);
    expect(screen.getByRole('heading', { name: 'Page not found' })).toBeInTheDocument();
    expect(screen.queryByText(WATERMARK_TEXT)).not.toBeInTheDocument();
    expect(screen.queryByText('TEST: Wasatch Heating')).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Open estimate follow-up' })).not.toBeInTheDocument();
    expect(document.querySelector('meta[name="robots"]')).toHaveAttribute('content', 'noindex, nofollow');
    expect(calls.fetch).toBe(0);
    expect(calls.xhr).toBe(0);
  });

  it('rejects a token shorter than 22 characters', () => {
    at(`/?flags=FF_PROTOTYPE_GALLERY`);
    render(<GalleryGate route={{ token: 'a'.repeat(21), screen: 'index' }} />);
    expect(screen.getByRole('heading', { name: 'Page not found' })).toBeInTheDocument();
    expect(galleryTokenOk(TOKEN)).toBe(true);
    expect(TOKEN.length).toBeGreaterThanOrEqual(22);
    expect(galleryRouteFromPath(`/demo/gallery/${TOKEN}/estimate-follow-up`)).toEqual({
      token: TOKEN,
      screen: 'estimate-follow-up',
    });
  });

  it('walks the estimate follow-up without fetch or XHR', async () => {
    const user = userEvent.setup();
    at(`/demo/gallery/${TOKEN}?flags=FF_PROTOTYPE_GALLERY`);
    const { container } = render(<GalleryGate route={{ token: TOKEN, screen: 'index' }} />);

    expect(await screen.findByRole('heading', { name: 'Prototype gallery' })).toBeInTheDocument();
    expect(container.querySelector('.prototype-brand-name span').textContent).toBe('TEST: Wasatch Heating');
    expectRibbon(container);
    expect(container.querySelector('.prototype-tile')).not.toBeNull();
    expectFooter(container, 'TEST: Wasatch Heating');
    const open = screen.getByRole('link', { name: 'Open estimate follow-up' });
    expect(open).toHaveAttribute('href', galleryHref(TOKEN, 'estimate-follow-up', '?flags=FF_PROTOTYPE_GALLERY'));

    await user.click(open);
    expect(await screen.findByRole('heading', { name: 'TEST: Wasatch Heating: 3 open estimates, $38,400' })).toBeInTheDocument();
    expectRibbon(container);
    expect(container.querySelector('img')).toBeNull();
    for (const row of container.querySelectorAll('.demo-estimates > li')) {
      expect(row.querySelector('.prototype-sample')).not.toBeNull();
    }
    for (const option of container.querySelectorAll('.demo-options li')) {
      expect(option.querySelector('.prototype-sample').textContent).toBe('Sample');
    }

    await user.click(screen.getByRole('button', { name: 'Send estimate' }));
    expect(screen.getByRole('heading', { name: 'Preview — nothing is sent' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Thank you' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Close the loop' })).toBeInTheDocument();
    const toast = screen.getByText(ACTION_TOAST);
    expect(toast).toBeInTheDocument();
    expect(container.querySelector('.prototype-scroll').contains(toast)).toBe(false);
    expectRibbon(container);
    for (const card of container.querySelectorAll('.demo-mail')) {
      expect(card.querySelector('.prototype-sample')).not.toBeNull();
    }

    await user.click(screen.getByRole('button', { name: 'See the homeowner reply' }));
    expect(screen.getByRole('heading', { name: 'Is there financing?' })).toBeInTheDocument();
    expectRibbon(container);
    expect(container.querySelector('.demo-quote .prototype-sample')).not.toBeNull();
    expect(container.querySelector('.demo-draft .prototype-sample')).not.toBeNull();
    await user.click(screen.getByRole('button', { name: 'Approve reply' }));
    expect(screen.getByText('Approved → schedule install')).toBeInTheDocument();
    expect(screen.getByText(ACTION_TOAST)).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'See the owner summary' }));
    expect(screen.getByRole('heading', { name: 'Recovered: $14,800. You own this workflow.' })).toBeInTheDocument();
    expectRibbon(container);

    await user.click(screen.getByRole('button', { name: 'Export sample data (JSON)' }));
    expect(screen.getByText(ACTION_TOAST)).toBeInTheDocument();
    expect(downloads).toEqual([]);
    expect(createObjectURL).not.toHaveBeenCalled();

    expect(calls.fetch).toBe(0);
    expect(calls.xhr).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(xhrMock).not.toHaveBeenCalled();
    expect(container.querySelector('img')).toBeNull();
    for (const link of container.querySelectorAll('a')) {
      expect(link.getAttribute('href') || '').not.toMatch(/^(mailto:|sms:|tel:|javascript:)/i);
    }
    expect(container.textContent).not.toMatch(/twilio|sms:/i);
    expect(document.querySelector('meta[name="robots"]')).toHaveAttribute('content', 'noindex, nofollow');
  });

  it('keeps the watermark visible for hostile brand data and hide params', async () => {
    at(`/demo/gallery/${TOKEN}/estimate-follow-up?flags=FF_PROTOTYPE_GALLERY,FF_HIDE_WATERMARK&fixture=hostile&watermark=0&hideWatermark=1`);
    const { container } = render(<GalleryGate route={{ token: TOKEN, screen: 'estimate-follow-up' }} />);

    const heading = await screen.findByRole('heading', { level: 1 });
    expect(heading.textContent).toContain('<script>alert(1)</script>');
    expect(container.querySelector('script')).toBeNull();
    expect(container.querySelector('img')).toBeNull();
    expect(container.innerHTML).not.toContain('<script>alert(1)</script>');
    expect(container.innerHTML).toContain('&lt;script&gt;');

    const mark = expectRibbon(container);
    expect(mark.getAttribute('aria-label')).toBe(WATERMARK_TEXT);
    const branded = container.querySelector('.prototype-screen');
    expect(branded.contains(mark)).toBe(false);
    expectFooter(container, 'TEST: <script>alert(1)</script>');
    expect(mark.getAttribute('hidden')).toBeNull();
    expect(paint(mark.style.backgroundColor)).toMatch(/#1e2a2f|rgb\(30,42,47\)/);
    expect(paint(mark.style.color)).toMatch(/#f3f6f5|rgb\(243,246,245\)/);
    expect(mark.style.display).toBe('block');
    expect(mark.style.visibility).toBe('visible');
    expect(mark.style.opacity).toBe('1');
    const computed = getComputedStyle(mark);
    expect(computed.display).not.toBe('none');
    expect(computed.visibility).not.toBe('hidden');
    expect(Number(computed.opacity)).toBe(1);
    expect(branded.getAttribute('data-brand-accent')).toBe('#2F6B57');
    expect(paint(mark.style.backgroundColor)).not.toBe(paint(branded.getAttribute('data-brand-accent')));
    expect(mark.getAttribute('style')).not.toContain('2F6B57');

    expect(calls.fetch).toBe(0);
    expect(calls.xhr).toBe(0);
  });

  it('ignores props that try to hide the watermark', () => {
    const { container } = render(<PrototypeWatermark hidden watermark="off" style={{ display: 'none', opacity: 0 }} />);
    const mark = container.querySelector('[data-prototype-watermark="true"]');
    expect(mark.textContent).toBe(WATERMARK_TEXT);
    expect(mark.style.display).toBe('block');
    expect(mark.style.opacity).toBe('1');
    expect(mark.hidden).toBe(false);
  });

  it('renders the exact ribbon on every prototype route', async () => {
    const cases = [
      {
        path: `/demo/gallery/${TOKEN}?flags=FF_PROTOTYPE_GALLERY,FF_HIDE_WATERMARK&watermark=0`,
        screen: 'index',
        heading: 'Prototype gallery',
      },
      {
        path: `/demo/gallery/${TOKEN}/estimate-follow-up?flags=FF_PROTOTYPE_GALLERY,0,no&watermark=0`,
        screen: 'estimate-follow-up',
        heading: /open estimates/,
      },
      {
        path: `/demo/gallery/${TOKEN}/not-in-this-build?flags=FF_PROTOTYPE_GALLERY&watermark=0&hideWatermark=1`,
        screen: 'unknown',
        heading: 'Prototype not in this build',
      },
    ];
    for (const item of cases) {
      at(item.path);
      const { container, unmount } = render(<GalleryGate route={{ token: TOKEN, screen: item.screen }} />);
      expect(await screen.findByRole('heading', { name: item.heading })).toBeInTheDocument();
      expectRibbon(container);
      expectFooter(container, 'TEST: Wasatch Heating');
      unmount();
    }
  });

  it('keeps the ribbon under theme overrides for pale yellow and dark navy', async () => {
    const style = document.createElement('style');
    style.textContent = [
      ':root { --paper: #F5E050; --ink: #F5E050; --juniper: #F5E050; --accent: #F5E050; }',
      '.prototype-ribbon, [data-prototype-ribbon] { background: #F5E050 !important; color: #14213D !important; display: none !important; visibility: hidden !important; opacity: 0 !important; min-height: 0 !important; }',
      '.prototype-tile { display: none !important; pointer-events: auto !important; opacity: 0 !important; }',
    ].join('\n');
    document.head.appendChild(style);
    try {
      at(`/demo/gallery/${TOKEN}?flags=FF_PROTOTYPE_GALLERY,FF_HIDE_WATERMARK&fixture=yellow&watermark=0`);
      const yellow = render(<GalleryGate route={{ token: TOKEN, screen: 'index' }} />);
      expect(await screen.findByRole('heading', { name: 'Prototype gallery' })).toBeInTheDocument();
      const yellowRibbon = expectRibbon(yellow.container);
      expect(paint(yellowRibbon.style.backgroundColor)).not.toMatch(/f5e050|245,224,80/);
      expect(yellow.container.querySelector('[data-brand-swatch]').getAttribute('data-brand-swatch')).toBe('#F5E050');
      expect(yellow.container.querySelector('.prototype-screen').getAttribute('data-brand-accent')).toBe('#2F6B57');
      expect(yellow.container.querySelector('[data-prototype-tile]').style.getPropertyPriority('display')).toBe('important');
      yellow.unmount();

      at(`/demo/gallery/${TOKEN}/estimate-follow-up?flags=anything,FF_PROTOTYPE_GALLERY&fixture=navy&watermark=0`);
      const navy = render(<GalleryGate route={{ token: TOKEN, screen: 'estimate-follow-up' }} />);
      expect(await screen.findByRole('heading', { name: /open estimates/ })).toBeInTheDocument();
      expectRibbon(navy.container);
      expect(navy.container.querySelector('[data-brand-swatch]').getAttribute('data-brand-swatch')).toBe('#14213D');
      expect(navy.container.querySelector('.prototype-screen').getAttribute('data-brand-accent')).toBe('#14213D');
      expectFooter(navy.container, 'TEST: Dark Navy Shop');
      navy.unmount();
    } finally {
      style.remove();
    }
  });

  it('shows the ribbon on the unknown prototype screen', async () => {
    at(`/demo/gallery/${TOKEN}/not-in-this-build?flags=FF_PROTOTYPE_GALLERY`);
    const { container } = render(<GalleryGate route={{ token: TOKEN, screen: 'unknown' }} />);
    expect(await screen.findByRole('heading', { name: 'Prototype not in this build' })).toBeInTheDocument();
    expectRibbon(container);
    expectFooter(container, 'TEST: Wasatch Heating');
  });

  it('noindexes the gallery with the /demo header and robots.txt', () => {
    const config = JSON.parse(readFileSync(path.join(webRoot, 'vercel.json'), 'utf8'));
    expect(config.headers[0].source).toBe('/demo/:path*');
    expect(config.headers[0].headers).toEqual([
      { key: 'X-Robots-Tag', value: 'noindex, nofollow' },
    ]);
    const galleryPath = `/demo/gallery/${TOKEN}/estimate-follow-up`;
    expect(galleryPath.startsWith('/demo/')).toBe(true);
    expect(galleryRouteFromPath(galleryPath).screen).toBe('estimate-follow-up');
    const robots = readFileSync(path.join(webRoot, 'public/robots.txt'), 'utf8');
    expect(robots).toContain('Disallow: /demo/gallery/');
  });
});
