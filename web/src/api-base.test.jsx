import { describe, expect, it } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import ApiBanner, { API_BANNER_HELP } from './ApiBanner';
import { api } from './api';
import { ErrorNote } from './ui';
import { installApiDefaults } from './test/defaults.js';
import Today from './views/Today';
import Leads from './views/Leads';
import {
  LOCAL_API_URL,
  PRODUCTION_API_URL,
  PRODUCTION_HOSTS,
  resolveApiBase,
  UNCONFIGURED_MESSAGE,
} from './api-base.js';

const PREVIEW_HOST = 'flowforward-engine-git-x-turk11.vercel.app';

function resolve(overrides) {
  return resolveApiBase({
    viteApiUrl: '',
    dev: false,
    prod: true,
    hostname: PREVIEW_HOST,
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
