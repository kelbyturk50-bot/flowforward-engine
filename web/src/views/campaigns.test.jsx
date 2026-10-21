import { beforeEach, describe, expect, it } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import App from '../App';
import { api } from '../api';
import { installApiDefaults } from '../test/defaults.js';
import { focus } from '../test/fixtures.js';
import Campaigns from './Campaigns';

function at(path) {
  window.history.pushState({}, '', path);
}

beforeEach(() => {
  installApiDefaults();
});

describe('campaigns list', () => {
  it('shows the fixture headlines, machine-open count, and both layouts', async () => {
    const user = userEvent.setup();
    render(<Campaigns />);
    expect(await screen.findByRole('heading', { name: 'Campaigns' })).toBeInTheDocument();
    expect(screen.getByText('Observed results of your own outreach. FlowForward never sends from here.')).toBeInTheDocument();

    const table = screen.getByRole('table', { name: 'Campaigns' });
    const cards = screen.getByRole('list', { name: 'Campaign cards' });
    const order = [
      'TEST: Proto-Oct furnace-tune-up estimate follow-up demo link',
      'TEST: HVAC-Oct',
      'TEST: HVAC-Nov',
      'TEST: Plumbing-Sep walk-ins',
    ];
    for (const root of [table, cards]) {
      const names = within(root).getAllByText(/^TEST:/).map((node) => node.textContent);
      expect(names).toEqual(order);
    }

    expect(within(table).getByText('37.5%')).toBeInTheDocument();
    expect(within(table).getByText('3 of 8 responded')).toBeInTheDocument();
    expect(within(table).getByText('1 of 8 converted')).toBeInTheDocument();
    expect(within(table).getByText('1 of 8 opened, no reply')).toBeInTheDocument();
    expect(within(table).getAllByText('12.5%').length).toBeGreaterThanOrEqual(2);
    const opened = within(table).getByText('1 of 8 opened, no reply').closest('.rate-cell');
    expect(within(opened).getByText('Approximate')).toBeInTheDocument();
    expect(within(opened).getByText('1 of 8 machine opens, no reply, excluded')).toBeInTheDocument();
    expect(within(table).getAllByText('Directional (n<30)').length).toBeGreaterThan(0);
    expect(within(cards).getByText('3 of 8 responded')).toBeInTheDocument();
    expect(within(table).getByText(/1 prototype view is tracked/)).toBeInTheDocument();
    expect(within(table).getAllByText('No touches logged').length).toBe(2);
    expect(within(table).getByText('Nov 3 – not set')).toBeInTheDocument();
    expect(screen.getByText(/likely-human only \(machine opens excluded\)/)).toBeInTheDocument();
    expect(screen.getByText(/never used in attribution or conversion/)).toBeInTheDocument();

    await user.click(screen.getByRole('switch', { name: 'Include machine opens' }));
    expect(within(table).getByText('25%')).toBeInTheDocument();
    expect(within(table).getByText('2 of 8 opened, no reply')).toBeInTheDocument();
    expect(within(cards).getByText('2 of 8 opened, no reply')).toBeInTheDocument();
    expect(within(table).getByText('3 of 8 responded')).toBeInTheDocument();
    expect(within(table).getByText('1 of 8 machine opens, no reply, included')).toBeInTheDocument();
    expect(within(table).queryByText('1 of 8 machine opens, no reply, excluded')).not.toBeInTheDocument();
    expect(screen.getByText(/Opens: including machine opens/)).toBeInTheDocument();
    expect(localStorage.getItem('ff.campaignMachineOpens')).toBe('1');

    await user.click(screen.getAllByRole('button', { name: 'About open counts' })[0]);
    expect(screen.getByRole('tooltip')).toHaveTextContent('Approximate, unreliable (Apple MPP).');
    expect(screen.getByRole('tooltip')).toHaveTextContent('never count toward attribution or conversion');
  });

  it('counts responded over touched leads and labels opens Approximate', async () => {
    const partial = {
      id: 'test-partial',
      name: 'TEST: Partial-Oct',
      channel: 'email',
      status: 'active',
      startDate: '2026-10-01',
      endDate: '2026-10-10',
      leads: [
        { id: 'a', touches: [{ type: 'sent' }, { type: 'replied', channel: 'email' }] },
        { id: 'b', touches: [{ type: 'sent' }] },
        { id: 'c', touches: [{ type: 'prototype_viewed' }] },
        { id: 'd', touches: [] },
      ],
    };
    render(<Campaigns load={async () => ({ campaigns: [partial] })} />);
    const table = await screen.findByRole('table', { name: 'Campaigns' });
    const row = within(table).getByRole('row', { name: /TEST: Partial-Oct/ });
    expect(within(row).getByText('1 of 2 responded')).toBeInTheDocument();
    expect(within(row).queryByText('1 of 4 responded')).not.toBeInTheDocument();
    expect(within(row).getByText('50%')).toBeInTheDocument();
    const opened = within(row).getByText('0 of 2 opened, no reply').closest('.rate-cell');
    expect(within(opened).getByText('Approximate')).toBeInTheDocument();
    expect(within(opened).getByText('0 of 2 machine opens, no reply, excluded')).toBeInTheDocument();
  });

  it('closes the open-count tooltip with Escape', async () => {
    const user = userEvent.setup();
    render(<Campaigns />);
    expect(await screen.findByRole('heading', { name: 'Campaigns' })).toBeInTheDocument();
    await user.click(screen.getAllByRole('button', { name: 'About open counts' })[0]);
    expect(screen.getByRole('tooltip')).toHaveTextContent('Approximate, unreliable (Apple MPP).');
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();
  });

  it('leaves New campaign inert', async () => {
    const user = userEvent.setup();
    at('/#/campaigns');
    render(<Campaigns />);
    expect((await screen.findAllByText('TEST: HVAC-Oct')).length).toBeGreaterThan(0);
    await user.click(screen.getByRole('button', { name: 'New campaign' }));
    expect(window.location.hash).toBe('#/campaigns');
    expect(screen.getByRole('heading', { name: 'Campaigns' })).toBeInTheDocument();
  });

  it('shows empty, loading, error, and filtered-to-nothing states', async () => {
    const user = userEvent.setup();
    const empty = render(<Campaigns load={async () => ({ campaigns: [] })} />);
    expect(await screen.findByRole('heading', { name: 'No campaigns yet' })).toBeInTheDocument();
    expect(screen.getByText('Create one to start tracking replies and booked calls from your outreach.')).toBeInTheDocument();
    expect(screen.queryByText('Sample')).not.toBeInTheDocument();
    expect(screen.queryByRole('radio', { name: 'Active' })).not.toBeInTheDocument();
    empty.unmount();

    const loading = render(<Campaigns load={() => new Promise(() => {})} />);
    const busy = await screen.findByText('Loading campaigns…');
    expect(busy.closest('[aria-busy="true"]')).toBeTruthy();
    expect(loading.container.querySelectorAll('.camp-skel-row')).toHaveLength(4);
    expect(screen.queryByRole('heading', { name: 'No campaigns yet' })).not.toBeInTheDocument();
    expect(screen.getByRole('radio', { name: 'All' })).toBeInTheDocument();
    loading.unmount();

    let calls = 0;
    const failing = () => {
      calls += 1;
      return Promise.reject(new Error('offline'));
    };
    render(<Campaigns load={failing} />);
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent("Couldn't load campaigns. Check your connection.");
    expect(screen.getByRole('radio', { name: 'Paused' })).toBeEnabled();
    await user.click(screen.getByRole('button', { name: 'Retry' }));
    expect(calls).toBe(2);
  });

  it('filters to nothing by status or date, then clears', async () => {
    const user = userEvent.setup();
    render(<Campaigns />);
    expect((await screen.findAllByText('TEST: HVAC-Oct')).length).toBeGreaterThan(0);
    await user.click(screen.getByRole('radio', { name: 'Paused' }));
    expect(screen.getByRole('heading', { name: 'No campaigns match these filters' })).toBeInTheDocument();
    expect(screen.queryByText('TEST: HVAC-Oct')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Clear filters' }));
    expect((await screen.findAllByText('TEST: HVAC-Oct')).length).toBeGreaterThan(0);

    await user.click(screen.getByRole('button', { name: 'Sep 24 – Oct 16' }));
    await user.click(screen.getByRole('option', { name: 'Jan 1 – Jan 31' }));
    expect(screen.getByRole('heading', { name: 'No campaigns match these filters' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Clear filters' }));
    expect(screen.getByRole('button', { name: 'Sep 24 – Oct 16' })).toHaveAttribute('aria-expanded', 'false');
    expect(screen.getAllByText('TEST: HVAC-Oct').length).toBeGreaterThan(0);
  });

  it('says Email only for a touched campaign that is not email', async () => {
    const phone = {
      id: 'test-phone',
      name: 'TEST: Phone-Oct',
      channel: 'phone',
      status: 'active',
      startDate: '2026-10-01',
      endDate: '2026-10-10',
      leads: [{ id: 'P1', touches: [{ type: 'call_logged', channel: 'phone' }, { type: 'replied', channel: 'phone' }] }],
    };
    render(<Campaigns load={async () => ({ campaigns: [phone] })} />);
    const table = await screen.findByRole('table', { name: 'Campaigns' });
    const phoneRow = within(table).getByRole('row', { name: /TEST: Phone-Oct/ });
    expect(within(phoneRow).getByText('Email only')).toBeInTheDocument();
    expect(within(phoneRow).getByText('1 of 1 responded')).toBeInTheDocument();
    expect(within(phoneRow).queryByText('Approximate')).not.toBeInTheDocument();
    expect(within(table).getByText('Approximate')).toBeInTheDocument();
    const cards = screen.getByRole('list', { name: 'Campaign cards' });
    expect(within(cards).queryByText('Opened, no response')).not.toBeInTheDocument();
    expect(within(cards).getByText('1 of 1 responded')).toBeInTheDocument();
  });
});

describe('campaigns flag gating', () => {
  it('hides Campaigns and leaves the phone tabs unchanged when the flag is off', async () => {
    at('/#/today');
    render(<App />);
    const rail = await screen.findByRole('navigation', { name: 'Main' });
    const tabs = screen.getByRole('navigation', { name: 'Mobile' });
    expect(within(rail).queryByRole('link', { name: 'Campaigns' })).not.toBeInTheDocument();
    expect(within(rail).getAllByRole('link').map((link) => link.textContent.replace(/\d+$/, '').trim())).toEqual([
      'Today', 'Leads', 'Proposals', 'Inbox', 'Pipeline', 'Projects', 'Settings',
    ]);
    expect(within(tabs).getAllByRole('link').map((link) => link.querySelector('span:not(.tab-badge)').textContent)).toEqual([
      'Today', 'Leads', 'Pipeline', 'Proposals', 'More',
    ]);

    at('/#/campaigns');
    window.dispatchEvent(new HashChangeEvent('hashchange'));
    expect(await screen.findByRole('heading', { name: 'Page not found' })).toBeInTheDocument();
    expect(screen.queryByText('Observed results of your own outreach. FlowForward never sends from here.')).not.toBeInTheDocument();
  });

  it('shows Campaigns on the rail and swaps the phone tab when the flag is on', async () => {
    const user = userEvent.setup();
    at('/?flags=FF_CAMPAIGNS#/campaigns');
    render(<App />);
    const rail = await screen.findByRole('navigation', { name: 'Main' });
    const tabs = screen.getByRole('navigation', { name: 'Mobile' });
    expect(within(rail).getAllByRole('link').map((link) => link.querySelector('span')?.textContent || link.textContent)).toEqual([
      'Today', 'Leads', 'Pipeline', 'Campaigns', 'Proposals', 'Inbox', 'Projects', 'Settings',
    ]);
    expect(within(tabs).getAllByRole('link').map((link) => link.querySelector('span:not(.tab-badge)').textContent)).toEqual([
      'Today', 'Leads', 'Pipeline', 'Campaigns', 'More',
    ]);
    expect(within(tabs).queryByRole('link', { name: /^Proposals/ })).not.toBeInTheDocument();
    expect(await screen.findByRole('heading', { name: 'Campaigns' })).toBeInTheDocument();
    expect(within(tabs).getByRole('link', { name: /^Campaigns/ })).toHaveAttribute('aria-current', 'page');

    at('/?flags=FF_CAMPAIGNS#/proposals');
    window.dispatchEvent(new HashChangeEvent('hashchange'));
    expect(await screen.findByRole('heading', { name: 'Proposals' })).toBeInTheDocument();
    expect(within(tabs).getByRole('link', { name: /^More/ })).toHaveAttribute('aria-current', 'page');
    expect(within(tabs).queryByRole('link', { name: /^Proposals/ })).not.toBeInTheDocument();

    await user.click(within(tabs).getByRole('link', { name: /^More/ }));
    expect(await screen.findByRole('heading', { name: 'More' })).toBeInTheDocument();
    const menu = screen.getAllByRole('link').filter((link) => link.className.includes('more-link'));
    expect(menu.map((link) => link.querySelector('.lead-name').textContent)).toEqual(['Proposals', 'Inbox', 'Projects']);
    expect(menu[0]).toHaveAttribute('href', '#/proposals');
  });

  it('rolls the proposals badge onto More when the flag is on', async () => {
    api.focus.mockResolvedValue({
      ...focus,
      followups_due: Array.from({ length: 12 }, (_, i) => ({ ...focus.followups_due[0], id: 100 + i })),
      task_queue: [1, 2, 3, 4].map((id) => ({ ...focus.task_queue[0], id, due_date: '2020-01-01' })),
    });
    api.proposalJobs.mockResolvedValue({ jobs: [], unreviewed: 14 });
    at('/?flags=FF_CAMPAIGNS#/today');
    render(<App />);
    const tabs = await screen.findByRole('navigation', { name: 'Mobile' });
    expect(within(tabs).getByLabelText('12 follow-ups due')).toHaveTextContent('9+');
    expect(within(tabs).queryByLabelText('14 proposals to review')).not.toBeInTheDocument();
    expect(within(tabs).getByLabelText('14 proposals to review, 4 overdue project tasks')).toHaveTextContent('9+');
    expect(within(tabs).getByRole('link', { name: /^Campaigns/ })).not.toHaveTextContent('9+');
  });
});
