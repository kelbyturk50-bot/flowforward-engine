import { afterEach, describe, expect, it, vi } from 'vitest';
import { api, _setRuntimeForTests, ApiError } from './src/api.js';
import { PRODUCTION_API_URL, PRODUCTION_HOSTS, UNCONFIGURED_MESSAGE } from './src/api-base.js';

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
    _setRuntimeForTests({ dev: false, prod: true, hostname: PROD_HOST, viteApiUrl: '', savedUrl: '' });
    await expect(api.health()).resolves.toEqual({ ok: true });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(fetchSpy.mock.calls[0][0]).toBe(`${PRODUCTION_API_URL}/health`);
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
