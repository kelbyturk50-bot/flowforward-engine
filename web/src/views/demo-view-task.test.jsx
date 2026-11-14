import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useState } from 'react';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { api } from '../api';
import { installApiDefaults } from '../test/defaults.js';
import { Toaster } from '../ui';
import Today from './Today';

const NOW = new Date('2026-11-14T18:00:00.000Z');
const css = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '../styles.css'), 'utf8');

const withPhone = {
  id: 1,
  prospect_id: 10,
  proposal_id: 20,
  company: 'TEST: Wasatch Heating',
  view_count: 2,
  last_viewed_at: '2026-11-14T21:14:00.000Z',
  source: 'onepager',
  trade: 'HVAC',
  city: 'Provo',
  phone: '(801) 555-0142',
  demo_link_expired: false,
};

const noPhone = {
  id: 2,
  prospect_id: 12,
  proposal_id: 21,
  company: 'TEST: Bonneville Plumbing',
  view_count: 1,
  last_viewed_at: '2026-11-14T21:14:00.000Z',
  source: 'demo',
  trade: 'Plumbing',
  city: 'Ogden',
  phone: null,
  demo_link_expired: false,
};

const expired = {
  ...withPhone,
  id: 3,
  demo_link_expired: true,
};

function Harness({ openLead }) {
  const [version, setVersion] = useState(0);
  return (
    <>
      <Today version={version} bump={() => setVersion((value) => value + 1)} openLead={openLead} openProject={() => {}} />
      <Toaster />
    </>
  );
}

function renderToday() {
  const openLead = vi.fn();
  const view = render(<Harness openLead={openLead} />);
  return { ...view, openLead };
}

beforeEach(() => {
  installApiDefaults();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('Today demo-view tasks', () => {
  it('hides the feature when the list is 404 not_found and stays quiet', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    renderToday();
    expect(await screen.findByRole('heading', { name: /Good (morning|afternoon|evening), Kelby/ })).toBeInTheDocument();
    expect(await screen.findByRole('heading', { name: 'Follow-ups due' })).toBeInTheDocument();
    await waitFor(() => expect(api.demoViewTasks).toHaveBeenCalled());
    expect(screen.queryByRole('heading', { name: 'Call them' })).not.toBeInTheDocument();
    expect(screen.queryByText('not_found')).not.toBeInTheDocument();
    expect(screen.queryByText(/Request failed/)).not.toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Open Wasatch Air Co' })).toBeInTheDocument();
    expect(api.sendProposal).not.toHaveBeenCalled();
    expect(api.triggerRun).not.toHaveBeenCalled();
    expect(api.checkInbox).not.toHaveBeenCalled();
    expect(api.sendInboxReply).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
    error.mockRestore();
    warn.mockRestore();
  });

  it('hides a 404 whose body did not parse', async () => {
    api.demoViewTasks.mockRejectedValue(Object.assign(new Error('Request failed (404)'), { status: 404 }));
    renderToday();
    expect(await screen.findByRole('heading', { name: 'Follow-ups due' })).toBeInTheDocument();
    await waitFor(() => expect(api.demoViewTasks).toHaveBeenCalled());
    expect(screen.queryByRole('heading', { name: 'Call them' })).not.toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('shows an open task with the Denver subline and a tel link', async () => {
    api.demoViewTasks.mockResolvedValue({ tasks: [withPhone] });
    renderToday();
    const region = await screen.findByRole('region', { name: 'Call them' });
    expect(within(region).getByText('Call TEST: Wasatch Heating: viewed your proposal 2 times')).toBeInTheDocument();
    expect(within(region).getByText('today 2:14 PM · proposal · HVAC · Provo')).toBeInTheDocument();
    expect(within(region).getByText('Nothing is sent from here.')).toBeInTheDocument();
    const call = within(region).getByRole('link', { name: 'Call TEST: Wasatch Heating at (801) 555-0142' });
    expect(call).toHaveAttribute('href', 'tel:8015550142');
    expect(within(region).getByRole('button', { name: 'Done, TEST: Wasatch Heating' })).toBeEnabled();
    expect(within(region).getByRole('button', { name: 'Snooze TEST: Wasatch Heating for 1 day' })).toBeEnabled();
    expect(within(region).getByRole('button', { name: 'Dismiss TEST: Wasatch Heating' })).toBeEnabled();
    expect(within(region).queryByText('No phone on file')).not.toBeInTheDocument();
    expect(within(region).queryByText('demo link expired')).not.toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Follow-ups due' })).toBeInTheDocument();
  });

  it('shows no phone, Open lead, and a live-demo subline', async () => {
    api.demoViewTasks.mockResolvedValue({ tasks: [noPhone] });
    const { openLead } = renderToday();
    const user = userEvent.setup();
    const region = await screen.findByRole('region', { name: 'Call them' });
    expect(within(region).getByText('Call TEST: Bonneville Plumbing: viewed your proposal 1 time')).toBeInTheDocument();
    expect(within(region).getByText('today 2:14 PM · live demo · Plumbing · Ogden')).toBeInTheDocument();
    expect(within(region).getByText('No phone on file')).toBeInTheDocument();
    expect(within(region).queryByRole('link', { name: /Call / })).not.toBeInTheDocument();
    await user.click(within(region).getByRole('button', { name: 'Open TEST: Bonneville Plumbing' }));
    expect(openLead).toHaveBeenCalledWith(12);
  });

  it('notes a dead demo link on the same card', async () => {
    api.demoViewTasks.mockResolvedValue({ tasks: [expired] });
    renderToday();
    const region = await screen.findByRole('region', { name: 'Call them' });
    expect(within(region).getByText('demo link expired')).toBeInTheDocument();
    expect(within(region).getByRole('link', { name: /Call TEST: Wasatch Heating/ })).toBeInTheDocument();
  });

  it('keeps a snoozed card after the list omits it on refresh', async () => {
    api.demoViewTasks.mockResolvedValue({ tasks: [withPhone] });
    api.demoViewTaskSnooze.mockResolvedValue({
      id: 1,
      status: 'open',
      snoozed_until: '2026-11-15T21:14:00.000Z',
    });
    const user = userEvent.setup();
    renderToday();
    const region = await screen.findByRole('region', { name: 'Call them' });
    await user.click(within(region).getByRole('button', { name: 'Snooze TEST: Wasatch Heating for 1 day' }));
    expect(await screen.findByText('Snoozed until tomorrow 2:14 PM', { exact: true })).toBeInTheDocument();
    await waitFor(() => expect(api.demoViewTaskSnooze).toHaveBeenCalledWith('1'));
    expect(screen.queryByRole('link', { name: /Call TEST: Wasatch Heating/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Done, TEST: Wasatch Heating' })).not.toBeInTheDocument();
    expect(screen.getByText('Snoozed until tomorrow 2:14 PM.')).toBeInTheDocument();
    expect(api.demoViewTasks.mock.calls.length).toBeGreaterThan(1);
    expect(api.sendProposal).not.toHaveBeenCalled();
    expect(screen.getByRole('heading', { name: 'Call next' })).toBeInTheDocument();
  });

  it('logs called and drops the card on Done', async () => {
    api.demoViewTasks.mockResolvedValue({ tasks: [withPhone, noPhone] });
    const user = userEvent.setup();
    renderToday();
    const region = await screen.findByRole('region', { name: 'Call them' });
    await user.click(within(region).getByRole('button', { name: 'Done, TEST: Wasatch Heating' }));
    expect(await screen.findByText('Logged “called” for TEST: Wasatch Heating.')).toBeInTheDocument();
    await waitFor(() => expect(api.demoViewTaskDone).toHaveBeenCalledWith('1'));
    expect(screen.queryByText('Call TEST: Wasatch Heating: viewed your proposal 2 times')).not.toBeInTheDocument();
    expect(screen.getByText('Call TEST: Bonneville Plumbing: viewed your proposal 1 time')).toBeInTheDocument();
    expect(api.demoViewTaskSnooze).not.toHaveBeenCalled();
    expect(api.demoViewTaskDismiss).not.toHaveBeenCalled();
    expect(api.sendProposal).not.toHaveBeenCalled();
    expect(api.sendInboxReply).not.toHaveBeenCalled();
  });

  it('dismisses one card and leaves the rest of Today up', async () => {
    api.demoViewTasks.mockResolvedValue({ tasks: [noPhone] });
    const user = userEvent.setup();
    renderToday();
    await user.click(await screen.findByRole('button', { name: 'Dismiss TEST: Bonneville Plumbing' }));
    expect(await screen.findByText('Dismissed the call for TEST: Bonneville Plumbing.')).toBeInTheDocument();
    await waitFor(() => expect(api.demoViewTaskDismiss).toHaveBeenCalledWith('2'));
    expect(screen.queryByRole('heading', { name: 'Call them' })).not.toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Follow-ups due' })).toBeInTheDocument();
    expect(api.sendProposal).not.toHaveBeenCalled();
  });

  it('says the call was already handled on 409 and does not show the code', async () => {
    api.demoViewTasks.mockResolvedValue({ tasks: [withPhone] });
    api.demoViewTaskDone.mockRejectedValue(Object.assign(new Error('task_not_open'), { status: 409 }));
    const user = userEvent.setup();
    renderToday();
    await user.click(await screen.findByRole('button', { name: 'Done, TEST: Wasatch Heating' }));
    expect(await screen.findByText('That call was already handled.')).toBeInTheDocument();
    expect(screen.queryByText('task_not_open')).not.toBeInTheDocument();
    await waitFor(() => {
      expect(screen.queryByText('Call TEST: Wasatch Heating: viewed your proposal 2 times')).not.toBeInTheDocument();
    });
  });

  it('shows a list failure without taking down the rest of Today', async () => {
    api.demoViewTasks.mockRejectedValue(Object.assign(new Error('Something went wrong.'), { status: 500 }));
    const user = userEvent.setup();
    renderToday();
    expect(await screen.findByRole('alert')).toHaveTextContent('Something went wrong.');
    expect(screen.getByRole('heading', { name: 'Call them' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Follow-ups due' })).toBeInTheDocument();
    expect(screen.queryByText('not_found')).not.toBeInTheDocument();
    api.demoViewTasks.mockResolvedValue({ tasks: [withPhone] });
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText('today 2:14 PM · proposal · HVAC · Provo')).toBeInTheDocument();
  });

  it('leaves an empty 200 list off the page', async () => {
    api.demoViewTasks.mockResolvedValue({ tasks: [] });
    renderToday();
    expect(await screen.findByRole('heading', { name: 'Follow-ups due' })).toBeInTheDocument();
    await waitFor(() => expect(api.demoViewTasks).toHaveBeenCalled());
    expect(screen.queryByRole('heading', { name: 'Call them' })).not.toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('keeps the call actions at least 44px and lets the title wrap', () => {
    const rule = css.slice(css.indexOf('.view-task-panel .btn {'), css.indexOf('.view-task-list'));
    expect(rule).toContain('min-height: 44px');
    expect(rule).toContain('min-width: 44px');
    expect(rule).toContain('white-space: normal');
    expect(css).toContain('.view-task-title { font-weight: 600; font-size: 1.05rem; line-height: 1.3; overflow-wrap: anywhere; }');
    expect(css).toContain('.view-task-actions { flex-direction: column; align-items: stretch; gap: .4rem; }');
    expect(css).toContain('.view-task-actions .btn { width: 100%; }');
    expect(css).toContain('font-family: var(--font)');
  });
});
