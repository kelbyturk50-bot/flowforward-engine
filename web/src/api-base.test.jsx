import { afterEach, describe, expect, it } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import ApiBanner, { API_BANNER_HELP } from './ApiBanner';
import { api, settings } from './api';
import { ErrorNote } from './ui';
import { installApiDefaults } from './test/defaults.js';
import Today from './views/Today';
import Leads from './views/Leads';
import Settings from './views/Settings';
import {
  API_URL_SCHEME_MESSAGE,
  API_URL_USERINFO_MESSAGE,
  LOCAL_API_URL,
  PRODUCTION_API_URL,
  PRODUCTION_HOSTS,
  acceptedApiUrl,
  apiUrlIssue,
  resolveApiBase,
  shouldStoreApiUrl,
  UNCONFIGURED_MESSAGE,
} from './api-base.js';

const PREVIEW_HOST = 'flowforward-engine-git-x-turk11.vercel.app';

function resolve(overrides) {
  return resolveApiBase({
    viteApiUrl: '',
    dev: false,
    prod: true,
    hostname: PREVIEW_HOST,
    port: '',
    protocol: 'https:',
    savedUrl: '',
    ...overrides,
  });
}

describe('resolveApiBase', () => {
  it('uses the production API on an exact production host', () => {
    for (const hostname of PRODUCTION_HOSTS) {
      expect(resolve({ hostname })).toEqual({
        url: PRODUCTION_API_URL,
        configured: true,
        source: 'production',
      });
    }
  });

  it('does not use the production API on port 444', () => {
    for (const host of PRODUCTION_HOSTS) {
      const page = new URL(`https://${host}:444/`);
      expect(page.port).toBe('444');
      expect(resolve({
        hostname: page.hostname,
        port: page.port,
        protocol: page.protocol,
      })).toEqual({ url: '', configured: false, source: 'unconfigured' });
    }
  });

  it('treats an explicit :443 as the default https port', () => {
    for (const host of PRODUCTION_HOSTS) {
      const page = new URL(`https://${host}:443/`);
      expect(page.hostname).toBe(host);
      expect(page.port).toBe('');
      expect(page.protocol).toBe('https:');
      expect(resolve({
        hostname: page.hostname,
        port: page.port,
        protocol: page.protocol,
      })).toEqual({
        url: PRODUCTION_API_URL,
        configured: true,
        source: 'production',
      });
    }
  });

  it('does not use the production API over http', () => {
    for (const host of PRODUCTION_HOSTS) {
      const page = new URL(`http://${host}/`);
      expect(page.protocol).toBe('http:');
      expect(page.port).toBe('');
      expect(resolve({
        hostname: page.hostname,
        port: page.port,
        protocol: page.protocol,
      })).toEqual({ url: '', configured: false, source: 'unconfigured' });
    }
  });

  it('does not configure a preview host', () => {
    const base = resolve({ hostname: PREVIEW_HOST });
    expect(PRODUCTION_HOSTS).not.toContain(PREVIEW_HOST);
    expect(base).toEqual({ url: '', configured: false, source: 'unconfigured' });
  });

  it('does not treat lookalike hosts as production', () => {
    for (const host of PRODUCTION_HOSTS) {
      for (const hostname of [`evil-${host}`, `${host}.evil.com`, `evil.${host}`]) {
        expect(resolve({ hostname })).toEqual({ url: '', configured: false, source: 'unconfigured' });
      }
    }
  });

  it('defaults dev to the local API port', () => {
    expect(resolve({
      dev: true,
      prod: false,
      hostname: 'localhost',
    })).toEqual({ url: LOCAL_API_URL, configured: true, source: 'dev' });
  });

  it('uses VITE_API_URL when it is set', () => {
    const viteApiUrl = 'https://staging.example.test/api/';
    expect(resolve({ viteApiUrl, hostname: PREVIEW_HOST }).url).toBe('https://staging.example.test/api');
    expect(resolve({ viteApiUrl, hostname: PRODUCTION_HOSTS[0] }).url).toBe('https://staging.example.test/api');
    expect(resolve({ viteApiUrl, dev: true, prod: false, hostname: 'localhost' }).url).toBe('https://staging.example.test/api');
  });

  it('treats an invalid VITE_API_URL as unset', () => {
    for (const viteApiUrl of [
      'ftp://files.example.test',
      'javascript:alert(1)',
      'not a url',
      'file:///tmp/api',
      'http://staging.example.test',
      'http://evil.com',
      'https://user:pass@staging.example.test',
      'https://user@staging.example.test',
    ]) {
      expect(resolve({ viteApiUrl, hostname: PREVIEW_HOST })).toEqual({
        url: '',
        configured: false,
        source: 'unconfigured',
      });
      expect(resolve({
        viteApiUrl,
        dev: true,
        prod: false,
        hostname: 'localhost',
      })).toEqual({ url: LOCAL_API_URL, configured: true, source: 'dev' });
      expect(resolve({ viteApiUrl, hostname: PRODUCTION_HOSTS[0] })).toEqual({
        url: PRODUCTION_API_URL,
        configured: true,
        source: 'production',
      });
    }
    expect(resolve({ viteApiUrl: 'http://localhost:3000', hostname: PREVIEW_HOST })).toEqual({
      url: 'http://localhost:3000',
      configured: true,
      source: 'env',
    });
    expect(resolve({ viteApiUrl: 'http://127.0.0.1:3000/', hostname: PREVIEW_HOST }).url).toBe('http://127.0.0.1:3000');
  });

  it('ignores a stored http://evil.com address and continues', () => {
    expect(resolve({ savedUrl: 'http://evil.com', hostname: PREVIEW_HOST })).toEqual({
      url: '',
      configured: false,
      source: 'unconfigured',
    });
    expect(resolve({
      savedUrl: 'http://evil.com',
      viteApiUrl: 'https://staging.example.test',
      hostname: PREVIEW_HOST,
    })).toEqual({
      url: 'https://staging.example.test',
      configured: true,
      source: 'env',
    });
    expect(resolve({
      savedUrl: 'http://evil.com',
      dev: true,
      prod: false,
      hostname: 'localhost',
    })).toEqual({ url: LOCAL_API_URL, configured: true, source: 'dev' });
    expect(resolve({ savedUrl: 'https://user:pass@evil.com', hostname: PREVIEW_HOST }).source).toBe('unconfigured');
    expect(resolve({ savedUrl: 'http://localhost:3000', hostname: PREVIEW_HOST })).toMatchObject({
      url: 'http://localhost:3000',
      source: 'settings',
    });
  });

  it('lets a saved Settings URL override the default, including on a preview', () => {
    const savedUrl = 'https://api.example.test/crm/';
    expect(resolve({ savedUrl, hostname: PREVIEW_HOST })).toMatchObject({
      url: 'https://api.example.test/crm',
      configured: true,
      source: 'settings',
    });
    expect(resolve({
      savedUrl: PRODUCTION_API_URL,
      viteApiUrl: 'https://staging.example.test',
      hostname: PREVIEW_HOST,
    }).url).toBe(PRODUCTION_API_URL);
  });

  it('ignores a blank saved URL', () => {
    expect(resolve({ savedUrl: '   ', hostname: PREVIEW_HOST }).configured).toBe(false);
  });
});

describe('ApiBanner', () => {
  it('shows the unconfigured message once, with a way to Settings', async () => {
    installApiDefaults();
    api.focus.mockRejectedValue(Object.assign(new Error(UNCONFIGURED_MESSAGE), { status: 0 }));
    render(
      <>
        <ApiBanner configured={false} />
        <Today version={0} bump={() => {}} openLead={() => {}} openProject={() => {}} />
      </>
    );
    expect(await screen.findByRole('heading', { name: /Good (morning|afternoon|evening), Kelby/ })).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByText('Loading your day…')).not.toBeInTheDocument());
    expect(screen.getAllByText(UNCONFIGURED_MESSAGE)).toHaveLength(1);
    expect(screen.getByRole('status')).toHaveTextContent(API_BANNER_HELP);
    expect(screen.getByRole('link', { name: 'Open Settings' })).toHaveAttribute('href', '#/settings');
    expect(screen.queryByRole('button', { name: 'Try again' })).not.toBeInTheDocument();
  });

  it('hides the same failure on other views', async () => {
    installApiDefaults();
    api.prospects.mockRejectedValue(Object.assign(new Error(UNCONFIGURED_MESSAGE), { status: 0 }));
    api.meta.mockRejectedValue(Object.assign(new Error(UNCONFIGURED_MESSAGE), { status: 0 }));
    render(
      <>
        <ApiBanner configured={false} />
        <Leads version={0} bump={() => {}} openLead={() => {}} />
      </>
    );
    expect(await screen.findByRole('heading', { name: 'Leads' })).toBeInTheDocument();
    await waitFor(() => expect(api.prospects).toHaveBeenCalled());
    expect(screen.getAllByText(UNCONFIGURED_MESSAGE)).toHaveLength(1);
    expect(screen.getByText('No leads loaded yet')).toBeInTheDocument();
    expect(screen.queryByText(/ranked by fit/)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Try again' })).not.toBeInTheDocument();
  });

  it('stays hidden when an API is configured', () => {
    render(<ApiBanner configured />);
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    expect(screen.queryByText(UNCONFIGURED_MESSAGE)).not.toBeInTheDocument();
  });

  it('still shows Try again for a real request failure', () => {
    render(<ErrorNote error={{ message: 'Request failed (500)' }} onRetry={() => {}} />);
    expect(screen.getByRole('alert')).toHaveTextContent('Request failed (500)');
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
  });
});

const UNSAFE_API_URLS = [
  'data:text/html,<b>x</b>',
  'data:...',
  'not a url',
  'javascript:alert(1)',
  'javascript:...',
  'ftp://x',
  'ftp://...',
  'http://evil.example',
];

describe('apiUrlIssue', () => {
  it('allows https, and http only for localhost and 127.0.0.1', () => {
    expect(apiUrlIssue('https://staging.example.test/api')).toBe('');
    expect(apiUrlIssue('https://flowforward-engine-production.up.railway.app')).toBe('');
    expect(apiUrlIssue('http://localhost:3000')).toBe('');
    expect(apiUrlIssue('http://127.0.0.1:3000/')).toBe('');
    expect(apiUrlIssue(' HTTP://LOCALHOST:3000 ')).toBe('');
  });

  it('rejects other http hosts and non-https schemes', () => {
    for (const value of [
      'http://10.1.1.1:3000',
      'http://localhost.evil.com',
      'http://evil.localhost',
      'http://127.0.0.1.evil.com',
      'http://example.com',
      'http://evil.com',
      'ftp://localhost',
      'not a url',
    ]) {
      expect(apiUrlIssue(value)).toBe(API_URL_SCHEME_MESSAGE);
    }
    expect(apiUrlIssue('   ')).toBe('Enter an API address.');
  });

  it('rejects stored and build-time values with the same rule', () => {
    for (const value of UNSAFE_API_URLS) {
      expect(apiUrlIssue(value)).not.toBe('');
      expect(acceptedApiUrl(value)).toBe('');
      expect(resolve({ savedUrl: value, hostname: PREVIEW_HOST })).toEqual({
        url: '',
        configured: false,
        source: 'unconfigured',
      });
      expect(resolve({ viteApiUrl: value, hostname: PREVIEW_HOST })).toEqual({
        url: '',
        configured: false,
        source: 'unconfigured',
      });
      expect(resolve({ savedUrl: value, hostname: PRODUCTION_HOSTS[0] })).toEqual({
        url: PRODUCTION_API_URL,
        configured: true,
        source: 'production',
      });
    }
  });

  it('rejects a username or password', () => {
    for (const value of [
      'https://user:pass@staging.example.test',
      'https://user@staging.example.test',
      'http://user:pass@localhost:3000',
      'http://user:pass@127.0.0.1',
    ]) {
      expect(apiUrlIssue(value)).toBe(API_URL_USERINFO_MESSAGE);
    }
  });
});

describe('shouldStoreApiUrl', () => {
  it('does not store a prefilled or default address', () => {
    expect(shouldStoreApiUrl('http://localhost:3000', 'http://localhost:3000')).toBe(false);
    expect(shouldStoreApiUrl('http://localhost:3000/', LOCAL_API_URL)).toBe(false);
    expect(shouldStoreApiUrl(` ${PRODUCTION_API_URL} `, PRODUCTION_API_URL)).toBe(false);
    expect(shouldStoreApiUrl('', '')).toBe(false);
  });

  it('stores an address the user changed', () => {
    expect(shouldStoreApiUrl('https://staging.example.test', '')).toBe(true);
    expect(shouldStoreApiUrl('https://staging.example.test', LOCAL_API_URL)).toBe(true);
    expect(shouldStoreApiUrl(PRODUCTION_API_URL, '')).toBe(true);
  });
});

describe('Settings API address', () => {
  let restore = () => {};

  afterEach(() => { restore(); });

  function watchSettings(initialUrl) {
    installApiDefaults();
    const writes = [];
    let url = initialUrl;
    let key = '';
    Object.defineProperty(settings, 'apiUrl', {
      configurable: true,
      get: () => url,
      set: (v) => { writes.push(v); url = v; },
    });
    Object.defineProperty(settings, 'apiKey', {
      configurable: true,
      get: () => key,
      set: (v) => { key = v; },
    });
    restore = () => {
      delete settings.apiUrl;
      delete settings.apiKey;
      settings.apiUrl = 'http://127.0.0.1:3000';
      settings.apiKey = 'test-key';
      restore = () => {};
    };
    return writes;
  }

  it('shows an inline message and does not save a non-https address', async () => {
    const user = userEvent.setup();
    const writes = watchSettings('http://127.0.0.1:3000');
    render(<Settings version={0} onSaved={() => {}} />);
    const address = screen.getByLabelText('API address');
    await user.clear(address);
    await user.type(address, 'http://10.1.1.1:3000');
    const save = screen.getByRole('button', { name: 'Save and connect' });
    expect(save).toBeDisabled();
    expect(screen.getByRole('alert')).toHaveTextContent(API_URL_SCHEME_MESSAGE);
    expect(writes).toEqual([]);
    expect(api.health).not.toHaveBeenCalled();
  });

  it('clears Connected and blocks Save when the address is invalid', async () => {
    const user = userEvent.setup();
    watchSettings('');
    render(<Settings version={0} onSaved={() => {}} />);
    expect(screen.getByText("Saved on this device only. Use an https address (http is fine for localhost). Reset goes back to this environment's default.")).toBeInTheDocument();
    const address = screen.getByLabelText('API address');
    await user.type(address, 'https://staging.example.test');
    await user.click(screen.getByRole('button', { name: 'Save and connect' }));
    expect(await screen.findByText('Connected. Your leads are loading.')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();

    await user.clear(address);
    await user.type(address, 'https://user:pass@staging.example.test');
    expect(screen.queryByText('Connected. Your leads are loading.')).not.toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent(API_URL_USERINFO_MESSAGE);
    expect(screen.getByRole('button', { name: 'Save and connect' })).toBeDisabled();
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    expect(api.health).toHaveBeenCalledTimes(1);
  });

  it('does not save the prefilled address when only the key is saved', async () => {
    const user = userEvent.setup();
    const writes = watchSettings(LOCAL_API_URL);
    render(<Settings version={0} onSaved={() => {}} />);
    expect(screen.getByLabelText('API address')).toHaveValue(LOCAL_API_URL);
    await user.click(screen.getByRole('button', { name: 'Save and connect' }));
    expect(await screen.findByText('Connected. Your leads are loading.')).toBeInTheDocument();
    expect(writes).toEqual([]);
    expect(api.health).toHaveBeenCalled();
  });

  it('clears a saved address when the field is blank', async () => {
    const user = userEvent.setup();
    const writes = watchSettings('https://staging.example.test');
    render(<Settings version={0} onSaved={() => {}} />);
    await user.clear(screen.getByLabelText('API address'));
    await user.click(screen.getByRole('button', { name: 'Save and connect' }));
    expect(await screen.findByText('Connected. Your leads are loading.')).toBeInTheDocument();
    expect(writes).toEqual(['']);
  });

  it('removes a saved address from Reset', async () => {
    const user = userEvent.setup();
    const writes = watchSettings('https://staging.example.test');
    render(<Settings version={0} onSaved={() => {}} />);
    await user.click(screen.getByRole('button', { name: 'Reset' }));
    expect(writes).toEqual(['']);
    expect(screen.getByLabelText('API address')).toHaveValue('');
    expect(api.health).not.toHaveBeenCalled();
  });

  it('does not save an address that includes a username or password', async () => {
    const user = userEvent.setup();
    const writes = watchSettings('');
    render(<Settings version={0} onSaved={() => {}} />);
    await user.type(screen.getByLabelText('API address'), 'https://user:pass@staging.example.test');
    expect(screen.getByRole('button', { name: 'Save and connect' })).toBeDisabled();
    expect(screen.getByRole('alert')).toHaveTextContent(API_URL_USERINFO_MESSAGE);
    expect(writes).toEqual([]);
    expect(api.health).not.toHaveBeenCalled();
  });

  it('saves an https address the user typed', async () => {
    const user = userEvent.setup();
    const writes = watchSettings('');
    render(<Settings version={0} onSaved={() => {}} />);
    const address = screen.getByLabelText('API address');
    await user.type(address, 'https://staging.example.test');
    await user.click(screen.getByRole('button', { name: 'Save and connect' }));
    expect(await screen.findByText('Connected. Your leads are loading.')).toBeInTheDocument();
    expect(writes).toEqual(['https://staging.example.test']);
  });
});
