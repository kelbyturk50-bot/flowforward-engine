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
  expect(sentence.textContent).toBe(`${FOOTER_LEAD}${name}`);
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
  expect(paint(ribbon.style.backgroundColor)).toMatch(/#1e2a2f|rgb\(30,42,47\)/);
  expect(paint(ribbon.style.color)).toMatch(/#ffffff|rgb\(255,255,255\)/);
  expect(ribbon.getAttribute('style')).not.toContain('var(');
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
    expect(screen.getByText('TEST: Wasatch Heating')).toBeInTheDocument();
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
    expect(screen.getByText(ACTION_TOAST)).toBeInTheDocument();
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
    expect(paint(mark.style.color)).toMatch(/#ffffff|rgb\(255,255,255\)/);
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
