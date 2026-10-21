import { beforeEach, describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { api } from '../api';
import { installApiDefaults } from '../test/defaults.js';
import ProposalDrawer from './ProposalDrawer';

const url = 'https://api.test/demo/prototype/' + 'a'.repeat(43);
const base = {
  id: 9, prospect_id: 3, version: 1, status: 'draft', company: 'TEST: Peak Plumbing', subject: 'ideas',
  body: 'Hi,\n\n{{ONEPAGER_URL}}\n\nKelby', followup1: 'One more idea.\n\nKelby', followup2: 'Closing the loop.',
  to_email: 'test+a@peak.test', analysis: {}, versions: [], preview: {}, onepager_url: 'https://api.test/p/x',
  updated_at: '2026-10-20T00:00:00Z', created_at: '2026-10-20T00:00:00Z',
};
const props = { id: 9, onClose: () => {}, bump: () => {}, openLead: () => {}, openProposal: () => {} };

beforeEach(() => { installApiDefaults(); });

describe('prototype line in the email editors', () => {
  it('shows the line that will be added to the first email and follow-up 1', async () => {
    api.proposal.mockResolvedValue({ ...base, prototype: { id: 1, url, expired: false, colors: {}, agent_type: 'scheduling', expires_at: new Date(Date.now() + 864e5).toISOString() } });
    render(<ProposalDrawer {...props} />);
    expect(await screen.findByText('Added after the one-pager link when it sends:')).toBeInTheDocument();
    expect(screen.getByText('Added before your sign-off when it sends:')).toBeInTheDocument();
    expect(screen.getAllByText((t) => t.includes(url)).length).toBeGreaterThanOrEqual(2);
    expect(screen.getAllByText((t) => t.includes('for Peak Plumbing')).length).toBeGreaterThanOrEqual(2);
  });

  it('says why when no link will be added', async () => {
    api.proposal.mockResolvedValue({ ...base, prototype: { id: 1, url: null, link_problem: 'key_missing', expired: false, colors: {}, agent_type: 'scheduling', expires_at: new Date().toISOString() } });
    render(<ProposalDrawer {...props} />);
    expect(await screen.findByText(/No prototype link will be added/)).toBeInTheDocument();
  });
});

describe('booking line', () => {
  it('shows every line the server will add, including the calendar link', async () => {
    api.proposal.mockResolvedValue({ ...base, prototype: null, additions: {
      first: [{ where: 'before your sign-off', text: "My calendar is here if that's easier: https://calendly.com/flowforward50" }],
      followup1: [],
    } });
    render(<ProposalDrawer {...props} />);
    expect(await screen.findByText(/My calendar is here if that's easier/)).toBeInTheDocument();
  });
});

describe('empty one-pager', () => {
  it('offers to rebuild it and calls the API', async () => {
    const { default: userEvent } = await import('@testing-library/user-event');
    api.proposal.mockResolvedValue({ ...base, status: 'sent', sent_at: '2026-10-20T00:00:00Z', onepager: { headline: 'A few ideas', intro: '', observations: [], opportunities: [] } });
    api.rebuildOnepager.mockResolvedValue({ id: 9 });
    render(<ProposalDrawer {...props} />);
    const btn = await screen.findByRole('button', { name: 'Rebuild one-pager' });
    expect(screen.getByText(/the email you already sent will show the full page/)).toBeInTheDocument();
    await userEvent.click(btn);
    expect(api.rebuildOnepager).toHaveBeenCalledWith(9);
  });

  it('stays hidden when the one-pager has content', async () => {
    api.proposal.mockResolvedValue({ ...base, onepager: { headline: 'x', intro: 'y', observations: [{ title: 'a', detail: 'b' }], opportunities: [] } });
    render(<ProposalDrawer {...props} />);
    await screen.findByText('Follow-up 1');
    expect(screen.queryByRole('button', { name: 'Rebuild one-pager' })).toBeNull();
  });
});
