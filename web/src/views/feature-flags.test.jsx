import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { api } from '../api';
import { flagRecords, savedFlag } from '../test/flag-fixtures.js';
import { flagEnabled } from '../flags';
import { installApiDefaults } from '../test/defaults.js';
import FeatureFlagsPanel from './FeatureFlags';

const css = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '../styles.css'), 'utf8');

function records(overrides = {}, options) {
  return flagRecords(overrides, options);
}

function flagRow(name) {
  return within(screen.getByRole('listitem', { name }));
}

describe('feature flags panel', () => {
  beforeEach(() => {
    installApiDefaults();
  });

  it('gives every flag control a 44px target', () => {
    const block = css.slice(css.indexOf('.flag-panel {'), css.indexOf('.flag-list'));
    expect(block).toContain('min-height: 44px');
    expect(block).toContain('min-width: 44px');
    expect(css).toContain('.flag-name { font-family: var(--font-num); font-weight: 600; font-size: 1.02rem; overflow-wrap: anywhere; }');
  });

  it('fails closed while loading and when the API errors, then Retry loads', async () => {
    const user = userEvent.setup();
    let resolveFlags;
    api.flags.mockReturnValue(new Promise((resolve) => { resolveFlags = resolve; }));
    const pending = render(<FeatureFlagsPanel />);
    expect(screen.getByRole('status')).toHaveTextContent('Loading feature flags…');
    expect(screen.getByRole('switch', { name: 'FF_CAMPAIGNS' })).toBeDisabled();
    expect(screen.getByRole('switch', { name: 'FF_CAMPAIGNS' })).toHaveAttribute('aria-checked', 'false');
    expect(screen.getByRole('switch', { name: 'FF_CAMPAIGN_OPEN_PIXEL' })).toBeDisabled();
    expect(screen.getByRole('switch', { name: 'FF_CAMPAIGN_OPEN_PIXEL' })).toHaveAttribute('aria-checked', 'false');
    resolveFlags(records());
    await waitFor(() => expect(screen.getByRole('switch', { name: 'FF_CAMPAIGNS' })).toBeEnabled());
    pending.unmount();

    api.flags.mockRejectedValue(Object.assign(new Error('Database unavailable'), { status: 500 }));
    render(<FeatureFlagsPanel />);
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Feature flags could not be loaded. Every flag is off.');
    expect(screen.getByRole('switch', { name: 'FF_CAMPAIGNS' })).toBeDisabled();
    expect(screen.getByRole('switch', { name: 'FF_CAMPAIGNS' })).toHaveAttribute('aria-checked', 'false');
    expect(screen.getByRole('switch', { name: 'FF_CAMPAIGN_OPEN_PIXEL' })).toHaveAttribute('aria-checked', 'false');
    expect(api.setFlag).not.toHaveBeenCalled();

    api.flags.mockResolvedValue(records());
    await user.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(screen.getByRole('switch', { name: 'FF_CAMPAIGNS' })).toBeEnabled());
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('reloads the list when Settings saves (version changes) without a Retry', async () => {
    api.flags.mockRejectedValueOnce(Object.assign(new Error('Missing or invalid API key'), { status: 401 }));
    const view = render(<FeatureFlagsPanel version={0} />);
    expect(await screen.findByRole('alert')).toHaveTextContent('Every flag is off.');
    api.flags.mockResolvedValue(records({ FF_CAMPAIGNS: { enabled: true } }));
    view.rerender(<FeatureFlagsPanel version={1} />);
    await waitFor(() => expect(screen.getByRole('switch', { name: 'FF_CAMPAIGNS' })).toHaveAttribute('aria-checked', 'true'));
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('fails closed when the payload is not a list', async () => {
    api.flags.mockResolvedValue({ flags: [] });
    render(<FeatureFlagsPanel />);
    expect(await screen.findByRole('alert')).toHaveTextContent('Every flag is off.');
    expect(screen.getByRole('switch', { name: 'FF_CAMPAIGNS' })).toHaveAttribute('aria-checked', 'false');
    expect(screen.getByRole('switch', { name: 'FF_CAMPAIGN_OPEN_PIXEL' })).toBeDisabled();
  });

  it('confirms a toggle, shows saving, then the saved flag', async () => {
    const user = userEvent.setup();
    api.flags.mockResolvedValue(records());
    let resolveSave;
    api.setFlag.mockImplementation(() => new Promise((resolve) => { resolveSave = resolve; }));
    render(<FeatureFlagsPanel />);
    await waitFor(() => expect(screen.getByRole('switch', { name: 'FF_CAMPAIGNS' })).toBeEnabled());
    await user.click(screen.getByRole('switch', { name: 'FF_CAMPAIGNS' }));
    expect(screen.getByText('Turn FF_CAMPAIGNS on?')).toBeInTheDocument();
    expect(api.setFlag).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByText('Turn FF_CAMPAIGNS on?')).not.toBeInTheDocument();
    expect(api.setFlag).not.toHaveBeenCalled();

    await user.click(screen.getByRole('switch', { name: 'FF_CAMPAIGNS' }));
    await user.click(screen.getByRole('button', { name: 'Confirm' }));
    expect(screen.getByRole('switch', { name: 'FF_CAMPAIGNS' })).toHaveTextContent('Saving…');
    expect(screen.getByRole('switch', { name: 'FF_CAMPAIGNS' })).toBeDisabled();
    expect(api.setFlag).toHaveBeenCalledWith('FF_CAMPAIGNS', true);
    resolveSave(savedFlag('FF_CAMPAIGNS', true, { updated_at: new Date().toISOString(), updated_by: 'Kelby' }));
    expect(await screen.findByRole('status')).toHaveTextContent('Saved.');
    expect(screen.getByRole('switch', { name: 'FF_CAMPAIGNS' })).toHaveAttribute('aria-checked', 'true');
    expect(flagRow('FF_CAMPAIGNS').getByText(/Last changed: Kelby/)).toBeInTheDocument();
    expect(screen.getByRole('switch', { name: 'FF_CAMPAIGN_OPEN_PIXEL' })).toHaveAttribute('aria-checked', 'false');
  });

  it('keeps the flag off when the save fails and Retry can save it', async () => {
    const user = userEvent.setup();
    api.flags.mockResolvedValue(records());
    api.setFlag.mockRejectedValueOnce(new Error('Database unavailable'));
    render(<FeatureFlagsPanel />);
    await waitFor(() => expect(screen.getByRole('switch', { name: 'FF_CAMPAIGNS' })).toBeEnabled());
    await user.click(screen.getByRole('switch', { name: 'FF_CAMPAIGNS' }));
    await user.click(screen.getByRole('button', { name: 'Confirm' }));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent("Couldn't save FF_CAMPAIGNS. It stays off.");
    expect(screen.getByRole('switch', { name: 'FF_CAMPAIGNS' })).toHaveAttribute('aria-checked', 'false');

    api.setFlag.mockResolvedValueOnce(savedFlag('FF_CAMPAIGNS', true, { updated_at: new Date().toISOString(), updated_by: 'Kelby' }));
    await user.click(within(alert).getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(screen.getByRole('switch', { name: 'FF_CAMPAIGNS' })).toHaveAttribute('aria-checked', 'true'));
    expect(screen.getByRole('status')).toHaveTextContent('Saved.');
  });

  it('shows an environment force as off and does not toggle it', async () => {
    const user = userEvent.setup();
    api.flags.mockResolvedValue(records({
      FF_PILOT_ESTIMATE_RECOVERY: {
        enabled: true,
        env_forced_off: true,
        updated_at: '2026-10-15T15:00:00.000Z',
        updated_by: 'crm',
      },
    }));
    render(<FeatureFlagsPanel />);
    const sw = await screen.findByRole('switch', { name: 'FF_PILOT_ESTIMATE_RECOVERY' });
    await waitFor(() => expect(screen.getByRole('switch', { name: 'FF_CAMPAIGNS' })).toBeEnabled());
    expect(sw).toBeDisabled();
    expect(sw).toHaveAttribute('aria-checked', 'false');
    expect(flagRow('FF_PILOT_ESTIMATE_RECOVERY').getByText('Forced off by the environment.')).toBeInTheDocument();
    await user.click(sw);
    expect(screen.queryByText(/Turn FF_PILOT_ESTIMATE_RECOVERY/)).not.toBeInTheDocument();
    expect(api.setFlag).not.toHaveBeenCalled();
  });

  it('shows env-only flags as read-only and never sends a PUT for them', async () => {
    const user = userEvent.setup();
    api.flags.mockResolvedValue(records({ FF_PILOT_ESTIMATE_SMS: { enabled: true } }));
    render(<FeatureFlagsPanel />);
    await waitFor(() => expect(screen.getByRole('switch', { name: 'FF_CAMPAIGNS' })).toBeEnabled());
    for (const name of ['FF_PILOT_ESTIMATE_SMS', 'FF_CAMPAIGN_OPEN_PIXEL']) {
      const sw = screen.getByRole('switch', { name });
      expect(sw).toBeDisabled();
      expect(flagRow(name).getByText('Read-only. Set by the server environment.')).toBeInTheDocument();
      await user.click(sw);
      expect(screen.queryByText(new RegExp(`Turn ${name}`))).not.toBeInTheDocument();
    }
    expect(screen.getByRole('switch', { name: 'FF_PILOT_ESTIMATE_SMS' })).toHaveAttribute('aria-checked', 'true');
    expect(flagRow('FF_CAMPAIGNS').queryByText(/Read-only/)).not.toBeInTheDocument();
    expect(api.setFlag).not.toHaveBeenCalled();
  });

  it('lists the prototype-on-draft flag on by default and can turn it off', async () => {
    const user = userEvent.setup();
    api.flags.mockResolvedValue(records({}, { seeded: true }));
    api.setFlag.mockResolvedValueOnce(savedFlag('FF_PROTOTYPE_ON_DRAFT', false));
    render(<FeatureFlagsPanel />);
    const sw = await screen.findByRole('switch', { name: 'FF_PROTOTYPE_ON_DRAFT' });
    await waitFor(() => expect(sw).toBeEnabled());
    expect(sw).toHaveAttribute('aria-checked', 'true');
    expect(flagRow('FF_PROTOTYPE_ON_DRAFT').getByText('Branded prototype on new proposal drafts')).toBeInTheDocument();
    await user.click(sw);
    expect(screen.getByText('Turn FF_PROTOTYPE_ON_DRAFT off?')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Confirm' }));
    expect(api.setFlag).toHaveBeenCalledWith('FF_PROTOTYPE_ON_DRAFT', false);
    await waitFor(() => expect(screen.getByRole('switch', { name: 'FF_PROTOTYPE_ON_DRAFT' })).toHaveAttribute('aria-checked', 'false'));
  });

  it('does not list live sending or the watermark, and ignores a preview query', async () => {
    window.history.pushState({}, '', '/?flags=FF_CAMPAIGNS,FF_PILOT_ESTIMATE_LIVE_SEND,FF_HIDE_WATERMARK');
    api.flags.mockResolvedValue([
      ...records(),
      { name: 'FF_PILOT_ESTIMATE_LIVE_SEND', enabled: true, env_forced_off: false, updated_at: null, updated_by: null, writable: true, source: 'db' },
      { name: 'FF_HIDE_WATERMARK', enabled: true, env_forced_off: false, updated_at: null, updated_by: null, writable: true, source: 'db' },
    ]);
    render(<FeatureFlagsPanel />);
    await waitFor(() => expect(screen.getByRole('switch', { name: 'FF_CAMPAIGNS' })).toBeEnabled());
    expect(screen.getByRole('switch', { name: 'FF_CAMPAIGNS' })).toHaveAttribute('aria-checked', 'false');
    expect(screen.getByRole('switch', { name: 'FF_CAMPAIGN_OPEN_PIXEL' })).toHaveAttribute('aria-checked', 'false');
    expect(flagEnabled('FF_CAMPAIGNS')).toBe(true);
    expect(flagEnabled('FF_PILOT_ESTIMATE_LIVE_SEND')).toBe(false);
    expect(flagEnabled('FF_HIDE_WATERMARK')).toBe(false);
    expect(screen.getByText(/preview override/i)).toBeInTheDocument();
    expect(screen.queryByRole('switch', { name: 'FF_PILOT_ESTIMATE_LIVE_SEND' })).not.toBeInTheDocument();
    expect(screen.queryByText(/FF_HIDE_WATERMARK/)).not.toBeInTheDocument();
    expect(screen.queryByText(/LIVE_SEND/)).not.toBeInTheDocument();
  });
});
