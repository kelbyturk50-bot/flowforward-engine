import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import PrototypeWatermark, { ACTION_TOAST, FOOTER_BUSINESS_FALLBACK, FOOTER_LEAD, footerBusinessName, WATERMARK_TEXT, liveToast } from '../components/PrototypeWatermark';
import { DARK_PAPER, DARK_SURFACE, contrastRatio, presentBrand } from './brand';
import GalleryGate from './GalleryGate';
import PrototypeLayout from './PrototypeLayout';
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
  expect(ribbon.style.backgroundColor).toBe('');
  expect(ribbon.style.color).toBe('');
  expect(ribbon.style.getPropertyPriority('background-color')).toBe('');
  expect(ribbon.style.getPropertyPriority('color')).toBe('');
  expect(ribbon.style.getPropertyPriority('-webkit-text-fill-color')).toBe('');
  expect(ribbon.style.fontWeight).toBe('600');
  expect(ribbon.style.fontSize).toBe('14px');
  expect(ribbon.style.fontFamily.toLowerCase()).toContain('barlow');
  expect(ribbon.style.fontFamily.toLowerCase()).toContain('system-ui');
  expect(ribbon.getAttribute('style')).toContain('safe-area-inset-top');
  expect(ribbon.getAttribute('style')).toContain('32px');
  expect(ribbon.getAttribute('style')).not.toContain('var(');
  expect(ribbon.getAttribute('style')).not.toContain('background');
  expect(ribbon.style.getPropertyPriority('display')).toBe('important');
  const tile = container.querySelector('[data-prototype-tile]');
  expect(container.querySelector('.prototype-screen').contains(ribbon)).toBe(false);
  expect(container.querySelector('.prototype-screen').contains(tile)).toBe(true);
  expect(tile.style.pointerEvents).toBe('none');
  expect(tile.style.zIndex).toBe('1');
  expect(tile.style.getPropertyValue('print-color-adjust')).toBe('exact');
  expect(tile.style.getPropertyPriority('print-color-adjust')).toBe('important');
  expect(tile.getAttribute('style')).toContain('0.05');
  expect(tile.getAttribute('style')).toContain('PROTOTYPE');
  expect(container.querySelector('.prototype-brand-name .prototype-sample').textContent).toBe('Sample business');
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
    const estimates = await screen.findByRole('heading', { name: /TEST: Wasatch Heating/ });
    expect(estimates).toHaveAccessibleName('TEST: Wasatch HeatingSample: 3Sample open estimates, $38,400Sample');
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
    expect(screen.getByRole('heading', { name: /Thanks for asking/ })).toHaveAccessibleName(/Sample/);
    expect(screen.getByRole('heading', { name: /Still open/ })).toHaveAccessibleName(/Sample/);
    expect(screen.getByRole('heading', { name: /Reminder to you/ })).toHaveAccessibleName(/Sample/);
    expect(screen.getByRole('heading', { name: /Sequence stopped/ })).toHaveAccessibleName(/Sample/);
    expect(container.querySelector('.prototype-sample')).not.toHaveAttribute('aria-hidden');
    expect(screen.getByText(/· Stopped/)).toBeInTheDocument();
    expect(screen.getAllByText(/Email from your mailbox/)).toHaveLength(3);
    expect(container.querySelectorAll('.demo-mail-stopped')).toHaveLength(1);
    expect(screen.queryByRole('heading', { name: /Call now/ })).not.toBeInTheDocument();
    expect(container.textContent).not.toMatch(/sms|text-back|text message/i);
    const toast = screen.getByText(ACTION_TOAST);
    expect(toast).toBeInTheDocument();
    expect(container.querySelector('.prototype-scroll').contains(toast)).toBe(false);
    expectRibbon(container);
    for (const card of container.querySelectorAll('.demo-mail')) {
      expect(card.querySelector('.prototype-sample')).not.toBeNull();
    }

    await user.click(screen.getByRole('button', { name: 'See the homeowner reply' }));
    expect(screen.getByRole('heading', { name: /Is there financing\?/ })).toHaveAccessibleName(/Sample/);
    expect(screen.getByText('Sequence stopped. They replied, so the Day 12 email does not send.')).toBeInTheDocument();
    expectRibbon(container);
    expect(container.querySelector('.demo-quote .prototype-sample')).not.toBeNull();
    expect(container.querySelector('.demo-draft .prototype-sample')).not.toBeNull();
    await user.click(screen.getByRole('button', { name: 'Approve reply' }));
    expect(screen.getByText('Approved → schedule install')).toBeInTheDocument();
    expect(screen.getByText(liveToast('send the reply'))).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'See the owner summary' }));
    expect(screen.getByRole('heading', { name: 'Sample job. You own this workflow.' })).toBeInTheDocument();
    expect(screen.queryByText(/Recovered:/)).not.toBeInTheDocument();
    expect(container.querySelector('.demo-steps').textContent).not.toMatch(/Recovered/);
    expectRibbon(container);

    await user.click(screen.getByRole('button', { name: 'Export sample data (JSON)' }));
    expect(screen.getByText(liveToast('keep the file on this device'))).toBeInTheDocument();
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
    expect(mark.style.backgroundColor).toBe('');
    expect(mark.style.color).toBe('');
    expect(mark.style.display).toBe('block');
    expect(mark.style.visibility).toBe('visible');
    expect(mark.style.opacity).toBe('1');
    const computed = getComputedStyle(mark);
    expect(computed.display).not.toBe('none');
    expect(computed.visibility).not.toBe('hidden');
    expect(Number(computed.opacity)).toBe(1);
    expect(branded.getAttribute('data-brand-accent')).toBe('#6F6F6F');
    expect(branded.getAttribute('data-on-accent')).toBe('#FFFFFF');
    expect(mark.getAttribute('style')).not.toContain('6F6F6F');
    expect(branded.getAttribute('data-brand-accent-dark')).toBe('#FFFFFF');
    expect(container.querySelector('.prototype-wordmark').textContent).toBe('TEST: <script>alert(1)</script>');
    expect(container.querySelector('svg')).toBeNull();

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
      {
        path: `/demo/gallery/${TOKEN}/scheduling?flags=FF_PROTOTYPE_GALLERY&watermark=0`,
        screen: 'scheduling',
        heading: 'Book a visit',
      },
      {
        path: `/demo/gallery/${TOKEN}/call?flags=FF_PROTOTYPE_GALLERY,FF_HIDE_WATERMARK&watermark=0`,
        screen: 'call',
        heading: 'Missed call',
      },
      {
        path: `/demo/gallery/${TOKEN}/bookkeeping?flags=FF_PROTOTYPE_GALLERY&watermark=0`,
        screen: 'bookkeeping',
        heading: 'Receipts',
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

  it('keeps ribbon slate and paper under a hostile role=note stylesheet', () => {
    const css = readFileSync(path.join(webRoot, 'src/styles.css'), 'utf8');
    const sheet = document.createElement('style');
    sheet.textContent = css.slice(css.indexOf('/* prototype-watermark:'), css.indexOf('/* ── Mobile'));
    const hostile = document.createElement('style');
    hostile.textContent = '[role=note]{background:#fff;color:#fff}';
    document.head.append(sheet, hostile);
    try {
      const brand = presentBrand({ name: 'TEST: Wasatch Heating', colors: { accent: '#FFFFFF' } });
      const { container } = render(<PrototypeLayout brand={brand}><h1>Color lock</h1></PrototypeLayout>);
      const mark = container.querySelector('[role=note]');
      const computed = getComputedStyle(mark);
      expect(paint(computed.backgroundColor)).toBe('rgb(30,42,47)');
      expect(paint(computed.color)).toBe('rgb(243,246,245)');
      const fill = paint(computed.getPropertyValue('-webkit-text-fill-color'));
      if (fill) expect(fill).toBe('rgb(243,246,245)');
    } finally {
      sheet.remove();
      hostile.remove();
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
      expect(yellow.container.querySelector('.prototype-screen').getAttribute('data-brand-accent')).toBe('#7D7000');
      expect(yellow.container.querySelector('.prototype-screen').getAttribute('data-on-accent')).toBe('#FFFFFF');
      expect(yellow.container.querySelector('.prototype-screen').getAttribute('data-brand-accent-dark')).toBe('#F5E050');
      expect(yellow.container.querySelector('[data-prototype-tile]').style.getPropertyPriority('display')).toBe('important');
      yellow.unmount();

      at(`/demo/gallery/${TOKEN}/estimate-follow-up?flags=anything,FF_PROTOTYPE_GALLERY&fixture=navy&watermark=0`);
      const navy = render(<GalleryGate route={{ token: TOKEN, screen: 'estimate-follow-up' }} />);
      expect(await screen.findByRole('heading', { name: /open estimates/ })).toBeInTheDocument();
      expectRibbon(navy.container);
      const navyScreen = navy.container.querySelector('.prototype-screen');
      expect(navyScreen.getAttribute('data-brand-accent')).toBe('#14213D');
      expect(navyScreen.getAttribute('data-on-accent')).toBe('#FFFFFF');
      const navyDark = navyScreen.getAttribute('data-brand-accent-dark');
      expect(navyDark).toBe('#7E8FB2');
      expect(contrastRatio('#14213D', DARK_PAPER)).toBeLessThan(4.5);
      expect(contrastRatio(navyDark, DARK_PAPER)).toBeGreaterThanOrEqual(4.5);
      expect(contrastRatio(navyDark, DARK_SURFACE)).toBeGreaterThanOrEqual(4.5);
      expectFooter(navy.container, 'TEST: Dark Navy Shop');
      navy.unmount();
    } finally {
      style.remove();
    }
  });

  it('uses this business in the footer when the name is only TEST:', () => {
    expect(footerBusinessName('TEST: Wasatch Heating')).toBe('TEST: Wasatch Heating');
    expect(footerBusinessName('test: Wasatch Heating')).toBe('test: Wasatch Heating');
    expect(footerBusinessName('TEST:')).toBe(FOOTER_BUSINESS_FALLBACK);
    expect(footerBusinessName('TEST:   ')).toBe(FOOTER_BUSINESS_FALLBACK);
    expect(footerBusinessName('test:')).toBe(FOOTER_BUSINESS_FALLBACK);
    expect(footerBusinessName('Test:')).toBe(FOOTER_BUSINESS_FALLBACK);
    expect(footerBusinessName('tEsT:   ')).toBe(FOOTER_BUSINESS_FALLBACK);
    const brand = presentBrand({ name: 'TEST:', colors: { accent: '#1F4E79' } });
    const { container } = render(<PrototypeLayout brand={brand}><h1>Bare prefix</h1></PrototypeLayout>);
    expect(container.querySelector('.prototype-wordmark').textContent).toBe('TEST:');
    expect(container.querySelector('.prototype-brand-name span').textContent).toBe('TEST:');
    expect(container.querySelector('.prototype-business').textContent).toBe('this business');
    expect(container.querySelector('.prototype-footer').textContent).not.toMatch(/endorsed by TEST:/);
    const lower = presentBrand({ name: 'test:', colors: { accent: '#1F4E79' } });
    const lowerView = render(<PrototypeLayout brand={lower}><h1>Lower prefix</h1></PrototypeLayout>);
    expect(lowerView.container.querySelector('.prototype-wordmark').textContent).toBe('test:');
    expect(lowerView.container.querySelector('.prototype-business').textContent).toBe('this business');
    expect(lowerView.container.querySelector('.prototype-footer').textContent).not.toMatch(/endorsed by test:/i);
    expectRibbon(container);
  });

  it('escapes markup in the business name and still shows the watermark', () => {
    const payloads = [
      'TEST: <style>[role=note]{display:none}</style>',
      'TEST: <img onerror=alert(1)>',
      'TEST: </div><script>alert(1)</script>',
      `TEST: ${'Very long shop name '.repeat(12)}`,
    ];
    for (const name of payloads) {
      const brand = presentBrand({ name, logoUrl: 'https://prospect.example/logo.png', colors: { accent: '#F5E050', primary: '#F5E050' } });
      const { container, unmount } = render(
        <PrototypeLayout brand={brand}><h1>Injection</h1></PrototypeLayout>,
      );
      const mark = expectRibbon(container);
      expect(container.querySelector('style')).toBeNull();
      expect(container.querySelector('script')).toBeNull();
      expect(container.querySelector('img')).toBeNull();
      expect(container.innerHTML).not.toContain('<style');
      expect(container.innerHTML).not.toContain('<img');
      expect(container.innerHTML).not.toContain('<script');
      expect(container.querySelector('.prototype-wordmark').textContent).toBe(brand.name);
      expect(mark.textContent).toBe(WATERMARK_TEXT);
      expect(mark.style.display).toBe('block');
      expect(mark.style.visibility).toBe('visible');
      expect(mark.style.opacity).toBe('1');
      expect(getComputedStyle(mark).display).not.toBe('none');
      expect(Number(getComputedStyle(mark).opacity)).toBe(1);
      expect(brand.logoUrl).toBe('');
      expect(brand.theme.accent).toBe('#7D7000');
      unmount();
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
