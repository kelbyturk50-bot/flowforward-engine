import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import App from '../App';
import { api } from '../api';
import { installApiDefaults } from '../test/defaults.js';
import { focus } from '../test/fixtures.js';
import Leads from './Leads';
import Pipeline from './Pipeline';

const shared = {
  version: 0,
  bump: () => {},
  openLead: () => {},
  openProject: () => {},
  openProposal: () => {},
};

function useNarrowViewport(narrow) {
  window.matchMedia = vi.fn().mockImplementation((query) => ({
    matches: narrow,
    media: query,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(),
  }));
}

beforeEach(() => {
  installApiDefaults();
  useNarrowViewport(false);
});

describe('phone tab bar', () => {
  it('shows Today, Leads, Pipeline, Proposals, and More, with Settings on the gear', async () => {
    render(<App />);
    const nav = await screen.findByRole('navigation', { name: 'Mobile' });
    for (const label of ['Today', 'Leads', 'Pipeline', 'Proposals', 'More']) {
      expect(within(nav).getByRole('link', { name: new RegExp(label) })).toBeInTheDocument();
    }
    expect(within(nav).queryByRole('link', { name: /Settings/ })).not.toBeInTheDocument();
    const gear = screen.getAllByRole('link', { name: 'Settings' }).find((a) => a.className.includes('gear-btn'));
    expect(gear).toBeTruthy();
    expect(gear).toHaveAttribute('aria-label', 'Settings');
    expect(gear.querySelector('circle')).not.toBeNull();
  });

  it('caps Today and Proposals at 9+ and puts the project count on More', async () => {
    api.focus.mockResolvedValue({
      ...focus,
      followups_due: Array.from({ length: 12 }, (_, i) => ({ ...focus.followups_due[0], id: 100 + i })),
      task_queue: [1, 2, 3, 4].map((id) => ({ ...focus.task_queue[0], id, due_date: '2020-01-01' })),
    });
    api.proposalJobs.mockResolvedValue({ jobs: [], unreviewed: 14 });
    render(<App />);
    const nav = await screen.findByRole('navigation', { name: 'Mobile' });
    expect(within(nav).getByLabelText('12 follow-ups due')).toHaveTextContent('9+');
    expect(within(nav).getByLabelText('14 proposals to review')).toHaveTextContent('9+');
    expect(within(nav).getByLabelText('4 overdue project tasks')).toHaveTextContent('4');
    expect(within(nav).getByRole('link', { name: /^Leads/ })).not.toHaveTextContent('9+');
    expect(within(nav).getByRole('link', { name: /^Pipeline/ })).not.toHaveTextContent(/\d/);
  });

  it('opens More onto Projects', async () => {
    const user = userEvent.setup();
    render(<App />);
    const nav = await screen.findByRole('navigation', { name: 'Mobile' });
    await user.click(within(nav).getByRole('link', { name: /^More/ }));
    expect(await screen.findByRole('heading', { name: 'More' })).toBeInTheDocument();
    const projects = screen.getAllByRole('link', { name: /Projects/ });
    expect(projects.some((a) => a.className.includes('more-link') && a.getAttribute('href') === '#/projects')).toBe(true);
    expect(screen.getAllByRole('link', { name: 'Settings' }).some((a) => a.className.includes('gear-btn'))).toBe(true);
    expect(within(screen.getByRole('navigation', { name: 'Mobile' })).queryByRole('link', { name: /Settings/ })).not.toBeInTheDocument();
  });
});

describe('phone today actions', () => {
  it('keeps +3 days outside the lead row tap target', async () => {
    useNarrowViewport(true);
    render(<App />);
    const snooze = await screen.findByRole('button', { name: '+3 days' });
    const open = screen.getByRole('button', { name: 'Open Peak Plumbing' });
    expect(open.contains(snooze)).toBe(false);
    expect(snooze.closest('.lead-actions')).toBeTruthy();
    expect(snooze.classList.contains('btn')).toBe(true);
  });
});

describe('phone leads', () => {
  it('shows a card with trade, abbreviated revenue, tier, and fit score', async () => {
    useNarrowViewport(true);
    render(<Leads {...shared} />);
    expect(await screen.findByText('HVAC · $4.5K')).toBeInTheDocument();
    const card = screen.getByRole('button', { name: /Wasatch Air Co/ });
    expect(within(card).getByText('A')).toBeInTheDocument();
    expect(within(card).getByText('86')).toBeInTheDocument();
    expect(screen.queryByRole('columnheader', { name: 'Trade' })).not.toBeInTheDocument();
  });

  it('filters trade and revenue from the bottom sheet', async () => {
    useNarrowViewport(true);
    const user = userEvent.setup();
    render(<Leads {...shared} />);
    await user.click(await screen.findByRole('button', { name: /^Filter/ }));
    const dialog = screen.getByRole('dialog', { name: 'Filter leads' });
    await user.selectOptions(within(dialog).getByRole('combobox', { name: 'Trade' }), 'HVAC');
    await user.selectOptions(within(dialog).getByRole('combobox', { name: 'Revenue' }), '1000000');
    await user.selectOptions(within(dialog).getByRole('combobox', { name: 'Sort' }), 'revenue');
    await waitFor(() => {
      expect(api.prospects).toHaveBeenCalledWith(expect.objectContaining({
        industry: 'HVAC', min_value: '1000000', sort: 'revenue',
      }));
    });
  });

  it('explains a rejected filter without leaving the page', async () => {
    useNarrowViewport(true);
    const rejected = new Error('bad_request');
    rejected.status = 400;
    api.prospects.mockRejectedValue(rejected);
    render(<Leads {...shared} />);
    expect(await screen.findByRole('alert')).toHaveTextContent('Those filters are not valid. Clear them and try again.');
    expect(screen.getByRole('heading', { name: 'Leads' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
  });
});

describe('phone pipeline chips', () => {
  it('shows stage, count, and dollars, and filters the list', async () => {
    useNarrowViewport(true);
    const user = userEvent.setup();
    render(<Pipeline {...shared} />);
    const contacted = await screen.findByRole('button', { name: /Contacted/ });
    expect(contacted).toHaveTextContent('1');
    expect(contacted).toHaveTextContent('$4.5K');
    expect(await screen.findByText('Peak Plumbing')).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Found' })).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /Won/ }));
    expect(await screen.findByText('Wasatch Air Co')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /Not a fit/ }));
    expect(await screen.findByText('Nothing in Not a fit yet.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Not a fit/ })).toHaveTextContent('$0');
  });
});
