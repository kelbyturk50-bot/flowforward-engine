import { createElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { api, _setRuntimeForTests, ApiError, currentApiBase } from './src/api.js';
import { PRODUCTION_API_URL, PRODUCTION_HOSTS, UNCONFIGURED_MESSAGE } from './src/api-base.js';
import ApiBanner, { API_BANNER_HELP } from './src/ApiBanner.jsx';
import { useAsync } from './src/ui.jsx';

const UNSAFE_STORED_URLS = [
  'data:text/html,<b>x</b>',
  'data:...',
  'not a url',
  'javascript:alert(1)',
  'javascript:...',
  'ftp://x',
  'ftp://...',
  'http://evil.example',
];

function Probe() {
  const base = currentApiBase();
  const { data } = useAsync(() => api.focus(), []);
  const count = data ? data.followups_due.length : null;
  return createElement('div', null,
    createElement(ApiBanner, { configured: base.configured }),
    count == null ? null : createElement('p', null, String(count)),
  );
}

const PREVIEW_HOST = 'flowforward-engine-git-x-turk11.vercel.app';
const PROD_HOST = PRODUCTION_HOSTS[0];

function okFetch() {
  return vi.fn(async () => ({
    ok: true,
    status: 200,
    json: async () => ({ ok: true }),
  }));
}

afterEach(() => {
  _setRuntimeForTests(null);
});

describe('real API client', () => {
  it('fetches the production API from an exact production host', async () => {
    const fetchSpy = okFetch();
    vi.stubGlobal('fetch', fetchSpy);
    const page = new URL(`https://${PROD_HOST}/`);
    _setRuntimeForTests({
      dev: false,
      prod: true,
      hostname: page.hostname,
      port: page.port,
      protocol: page.protocol,
      viteApiUrl: '',
      savedUrl: '',
    });
    await expect(api.health()).resolves.toEqual({ ok: true });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(fetchSpy.mock.calls[0][0]).toBe(`${PRODUCTION_API_URL}/health`);
  });

  it('does not fetch when a production hostname is on port 444 or http', async () => {
    const fetchSpy = vi.fn(() => { throw new Error('fetch must not run'); });
    vi.stubGlobal('fetch', fetchSpy);
    for (const host of PRODUCTION_HOSTS) {
      for (const url of [`https://${host}:444/`, `http://${host}/`]) {
        const page = new URL(url);
        _setRuntimeForTests({
          dev: false,
          prod: true,
          hostname: page.hostname,
          port: page.port,
          protocol: page.protocol,
          viteApiUrl: '',
          savedUrl: '',
        });
        await expect(api.health()).rejects.toMatchObject({
          message: UNCONFIGURED_MESSAGE,
          status: 0,
        });
        await expect(api.health()).rejects.toBeInstanceOf(ApiError);
      }
    }
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('treats an explicit https :443 as the default port and fetches production', async () => {
    const fetchSpy = okFetch();
    vi.stubGlobal('fetch', fetchSpy);
    for (const host of PRODUCTION_HOSTS) {
      const page = new URL(`https://${host}:443/`);
      expect(page.port).toBe('');
      expect(page.protocol).toBe('https:');
      _setRuntimeForTests({
        dev: false,
        prod: true,
        hostname: page.hostname,
        port: page.port,
        protocol: page.protocol,
        viteApiUrl: '',
        savedUrl: '',
      });
      await api.health();
    }
    expect(fetchSpy).toHaveBeenCalledTimes(PRODUCTION_HOSTS.length);
    for (const call of fetchSpy.mock.calls) {
      expect(call[0]).toBe(`${PRODUCTION_API_URL}/health`);
    }
  });

  it('shows no fetch for a preview host', async () => {
    const fetchSpy = vi.fn(() => { throw new Error('fetch must not run'); });
    vi.stubGlobal('fetch', fetchSpy);
    _setRuntimeForTests({ dev: false, prod: true, hostname: PREVIEW_HOST, viteApiUrl: '', savedUrl: '' });
    await expect(api.health()).rejects.toMatchObject({
      message: UNCONFIGURED_MESSAGE,
      status: 0,
    });
    await expect(api.health()).rejects.toBeInstanceOf(ApiError);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('shows no fetch for lookalike hosts', async () => {
    const fetchSpy = vi.fn(() => { throw new Error('fetch must not run'); });
    vi.stubGlobal('fetch', fetchSpy);
    for (const host of PRODUCTION_HOSTS) {
      for (const hostname of [`evil-${host}`, `${host}.evil.com`]) {
        _setRuntimeForTests({ dev: false, prod: true, hostname, viteApiUrl: '', savedUrl: '' });
        await expect(api.focus()).rejects.toMatchObject({ message: UNCONFIGURED_MESSAGE });
      }
    }
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('uses localhost:3000 in dev when VITE_API_URL is unset', async () => {
    expect(import.meta.env.DEV).toBe(true);
    expect(import.meta.env.VITE_API_URL).toBeFalsy();
    const fetchSpy = okFetch();
    vi.stubGlobal('fetch', fetchSpy);
    await api.health();
    expect(fetchSpy.mock.calls[0][0]).toBe('http://localhost:3000/health');
  });

  it('uses VITE_API_URL when set, including on a preview host', async () => {
    const fetchSpy = okFetch();
    vi.stubGlobal('fetch', fetchSpy);
    _setRuntimeForTests({
      dev: false,
      prod: true,
      hostname: PREVIEW_HOST,
      viteApiUrl: 'https://staging.example.test/',
      savedUrl: '',
    });
    await api.health();
    expect(fetchSpy.mock.calls[0][0]).toBe('https://staging.example.test/health');
  });

  it('ignores an invalid VITE_API_URL and continues resolution', async () => {
    const fetchSpy = vi.fn(() => { throw new Error('fetch must not run'); });
    vi.stubGlobal('fetch', fetchSpy);
    _setRuntimeForTests({
      dev: false,
      prod: true,
      hostname: PREVIEW_HOST,
      viteApiUrl: 'javascript:alert(1)',
      savedUrl: '',
    });
    await expect(api.health()).rejects.toMatchObject({ message: UNCONFIGURED_MESSAGE, status: 0 });
    expect(fetchSpy).not.toHaveBeenCalled();

    vi.stubGlobal('fetch', okFetch());
    _setRuntimeForTests({
      dev: true,
      prod: false,
      hostname: 'localhost',
      viteApiUrl: 'not a url',
      savedUrl: '',
    });
    await api.health();
    expect(fetch).toHaveBeenCalledWith('http://localhost:3000/health', expect.anything());
  });

  it('treats a pre-seeded unsafe ff.apiUrl as unset on a preview', async () => {
    const fetchSpy = vi.fn((url) => { throw new Error(`fetch must not run ${url}`); });
    vi.stubGlobal('fetch', fetchSpy);
    for (const stored of UNSAFE_STORED_URLS) {
      localStorage.setItem('ff.apiUrl', stored);
      _setRuntimeForTests({
        dev: false,
        prod: true,
        hostname: PREVIEW_HOST,
        port: '',
        protocol: 'https:',
        viteApiUrl: '',
      });
      const view = render(createElement(Probe));
      expect(await screen.findByRole('status')).toHaveTextContent(UNCONFIGURED_MESSAGE);
      expect(screen.getByRole('status')).toHaveTextContent(API_BANNER_HELP);
      expect(screen.getByRole('link', { name: 'Open Settings' })).toBeInTheDocument();
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(fetchSpy.mock.calls.map((call) => String(call[0])).join(' ')).not.toContain(PREVIEW_HOST);
      view.unmount();
    }
  });

  it('uses the production API when a stored address is unsafe and the host is production', async () => {
    const fetchSpy = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ followups_due: [], counts: {} }),
    }));
    vi.stubGlobal('fetch', fetchSpy);
    const page = new URL(`https://${PROD_HOST}/`);
    for (const stored of UNSAFE_STORED_URLS) {
      localStorage.setItem('ff.apiUrl', stored);
      _setRuntimeForTests({
        dev: false,
        prod: true,
        hostname: page.hostname,
        port: page.port,
        protocol: page.protocol,
        viteApiUrl: '',
      });
      const view = render(createElement(Probe));
      expect(screen.queryByRole('status')).not.toBeInTheDocument();
      expect(await screen.findByText('0')).toBeInTheDocument();
      const called = String(fetchSpy.mock.calls.at(-1)[0]);
      expect(called.startsWith(`${PRODUCTION_API_URL}/api/focus`)).toBe(true);
      expect(called).not.toContain(PREVIEW_HOST);
      expect(called).not.toContain('evil.example');
      view.unmount();
    }
  });

  it('treats the same unsafe values as unset when they are VITE_API_URL', async () => {
    const fetchSpy = vi.fn((url) => { throw new Error(`fetch must not run ${url}`); });
    vi.stubGlobal('fetch', fetchSpy);
    for (const viteApiUrl of UNSAFE_STORED_URLS) {
      localStorage.removeItem('ff.apiUrl');
      _setRuntimeForTests({
        dev: false,
        prod: true,
        hostname: PREVIEW_HOST,
        port: '',
        protocol: 'https:',
        viteApiUrl,
        savedUrl: '',
      });
      const view = render(createElement(Probe));
      expect(await screen.findByRole('status')).toHaveTextContent(UNCONFIGURED_MESSAGE);
      expect(fetchSpy).not.toHaveBeenCalled();
      view.unmount();
    }
  });

  it('ignores a VITE_API_URL that is http on a public host or has a password', async () => {
    const fetchSpy = vi.fn(() => { throw new Error('fetch must not run'); });
    vi.stubGlobal('fetch', fetchSpy);
    for (const viteApiUrl of ['http://evil.com', 'https://user:pass@staging.example.test']) {
      _setRuntimeForTests({ dev: false, prod: true, hostname: PREVIEW_HOST, viteApiUrl, savedUrl: '' });
      await expect(api.health()).rejects.toMatchObject({ message: UNCONFIGURED_MESSAGE, status: 0 });
    }
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('uses a Settings-saved URL the user stored, and only then', async () => {
    const fetchSpy = okFetch();
    vi.stubGlobal('fetch', fetchSpy);
    _setRuntimeForTests({ dev: false, prod: true, hostname: PREVIEW_HOST, viteApiUrl: '' });
    await expect(api.health()).rejects.toMatchObject({ message: UNCONFIGURED_MESSAGE });
    expect(fetchSpy).not.toHaveBeenCalled();

    localStorage.setItem('ff.apiUrl', PRODUCTION_API_URL);
    await api.health();
    expect(fetchSpy.mock.calls[0][0]).toBe(`${PRODUCTION_API_URL}/health`);
  });
});
