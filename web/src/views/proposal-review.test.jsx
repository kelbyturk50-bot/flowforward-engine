import { beforeEach, describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { api } from '../api';
import { summary } from '../test/fixtures.js';
import { installApiDefaults } from '../test/defaults.js';
import ProposalDrawer from './ProposalDrawer';
import Proposals from './Proposals';
import Settings from './Settings';

const halt = {
  event: 'followups.halted',
  error_class: 'auth',
  provider: 'gmail',
  first_seen: '2026-10-30T12:00:00.000Z',
  halted_ticks: 2,
};

const review = {
  id: 9,
  prospect_id: 3,
  version: 1,
  status: 'manual_review',
  company: 'TEST: Peak Plumbing',
  industry: 'Plumbing',
  city: 'Ogden',
  subject: 'ideas',
  body: 'Hi',
  followup1: 'One more idea.',
  followup2: 'Closing the loop.',
  to_email: 'test+a@peak.test',
  to_name: 'Dana',
  stop_reason: 'transient_max_age',
  error: 'transient_max_age',
  analysis: {},
  versions: [],
  preview: {},
  onepager_url: 'https://api.test/p/x',
  updated_at: '2026-10-20T00:00:00Z',
  created_at: '2026-10-20T00:00:00Z',
  fit_score: 72,
  fit_tier: 'B',
};

beforeEach(() => { installApiDefaults(); });

describe('follow-up halt and manual review', () => {
  it('shows the halt notice on Proposals and Settings', async () => {
    api.proposalSummary.mockResolvedValue({ ...summary, halt });
    const proposals = render(<Proposals version={1} bump={() => {}} openProposal={() => {}} />);
    expect(await screen.findByText('Follow-ups are paused: Gmail access expired. Reconnect Gmail in Settings.')).toBeInTheDocument();
    proposals.unmount();

    const settings = render(<Settings version={1} onSaved={() => {}} />);
    expect(await screen.findByText('Follow-ups are paused: Gmail access expired. Reconnect Gmail in Settings.')).toBeInTheDocument();
    settings.unmount();
  });

  it('shows plain copy and the three review actions, and hides the raw reason', async () => {
    api.proposal.mockResolvedValue(review);
    api.proposals.mockResolvedValue({ proposals: [review] });
    render(<ProposalDrawer id={9} onClose={() => {}} bump={() => {}} openLead={() => {}} openProposal={() => {}} />);
    expect(await screen.findByText('Gmail kept failing for 3 days, so we stopped retrying.')).toBeInTheDocument();
    expect(screen.getByText('Needs review')).toBeInTheDocument();
    expect(screen.queryByText('transient_max_age')).toBeNull();
    expect(screen.queryByText('manual_review')).toBeNull();
    expect(screen.getByRole('button', { name: 'Restore to review' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Mark as sent' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Mark not sent' })).toBeEnabled();

    await userEvent.click(screen.getByRole('button', { name: 'Mark as sent' }));
    expect(api.markSentProposal).toHaveBeenCalledWith(9, 'Recorded from review', { delivered: true });
    await userEvent.click(screen.getByRole('button', { name: 'Mark not sent' }));
    expect(api.markSentProposal).toHaveBeenCalledWith(9, undefined, { not_sent: true });
    await userEvent.click(screen.getByRole('button', { name: 'Restore to review' }));
    expect(api.restoreProposal).toHaveBeenCalledWith(9);
  });

  it('lists a needs-review row on the Closed tab without the raw status', async () => {
    api.proposalSummary.mockResolvedValue({ ...summary, counts: { ...summary.counts, closed: 1 } });
    api.proposals.mockImplementation(async (filters = {}) => (
      filters.view === 'closed' ? { proposals: [{ ...review, fit_verdict: null }] } : { proposals: [] }
    ));
    render(<Proposals version={1} bump={() => {}} openProposal={() => {}} />);
    await userEvent.click(await screen.findByRole('tab', { name: /Closed/ }));
    expect(await screen.findByText('Gmail kept failing for 3 days, so we stopped retrying.')).toBeInTheDocument();
    expect(screen.getByText('Needs review')).toBeInTheDocument();
    expect(screen.queryByText('manual_review')).toBeNull();
    expect(screen.queryByText('transient_max_age')).toBeNull();
  });
});
