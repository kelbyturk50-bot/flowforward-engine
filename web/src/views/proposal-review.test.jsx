import { beforeEach, describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { api } from '../api';
import { summary } from '../test/fixtures.js';
import { installApiDefaults } from '../test/defaults.js';
import ProposalDrawer from './ProposalDrawer';
import Proposals from './Proposals';
import Settings from './Settings';

const causes = [
  ['oauth_expired', 'Follow-ups are paused: Gmail access expired. Reconnect Gmail in Settings.'],
  ['token_missing', 'Follow-ups are paused: Gmail isn\'t connected. Connect Gmail in Settings.'],
  ['insufficient_permissions', 'Follow-ups are paused: Gmail is missing send permission. Reconnect Gmail in Settings and allow sending.'],
  ['smtp_auth', 'Follow-ups are paused: the mail server rejected the login. Check the SMTP settings.'],
  ['sender', 'Follow-ups are paused: the mail server rejected the sender address. Check the sender and Reply-To in Settings.'],
  ['other', 'Follow-ups are paused: mail needs attention before anything else goes out. Open Settings.'],
];

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
  versions: [{ id: 9, version: 1, status: 'manual_review' }],
  preview: {},
  onepager_url: 'https://api.test/p/x',
  updated_at: '2026-10-20T00:00:00Z',
  created_at: '2026-10-20T00:00:00Z',
  fit_score: 72,
  fit_tier: 'B',
};

beforeEach(() => { installApiDefaults(); });

describe('follow-up halt and manual review', () => {
  for (const [cause, text] of causes) {
    it(`shows the ${cause} halt on Proposals and at the top of Settings`, async () => {
      const halt = { event: 'followups.halted', error_class: 'auth', provider: 'gmail', cause, halted_ticks: 1 };
      api.proposalSummary.mockResolvedValue({ ...summary, halt });
      const proposals = render(<Proposals version={1} bump={() => {}} openProposal={() => {}} />);
      const note = await screen.findByRole('status');
      expect(note).toHaveClass('halt-banner');
      expect(note).not.toHaveClass('setup-note');
      expect(note).toHaveTextContent(text);
      if (text.includes('Settings')) {
        expect(note.querySelector('a')).toHaveAttribute('href', '#/settings');
      }
      proposals.unmount();

      const settings = render(<Settings version={1} onSaved={() => {}} />);
      await screen.findByText(/Follow-ups are paused/);
      const banner = settings.container.querySelector('.halt-banner');
      const heading = screen.getByRole('heading', { name: 'Settings' });
      const connection = screen.getByRole('heading', { name: 'Connection' });
      expect(banner).toHaveClass('halt-banner');
      expect(banner).toHaveTextContent(text);
      expect(heading.compareDocumentPosition(banner) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
      expect(banner.compareDocumentPosition(connection) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
      settings.unmount();
    });
  }

  it('shows a read-only Needs review row and hides the raw reason', async () => {
    api.proposal.mockResolvedValue(review);
    api.proposals.mockResolvedValue({ proposals: [review] });
    render(<ProposalDrawer id={9} onClose={() => {}} bump={() => {}} openLead={() => {}} openProposal={() => {}} />);
    expect(await screen.findByText('Gmail kept failing for 3 days, so we stopped retrying.')).toBeInTheDocument();
    expect(screen.getByText('Needs review')).toBeInTheDocument();
    expect(screen.queryByText('transient_max_age')).toBeNull();
    expect(screen.queryByText('manual_review')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Restore to review' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Mark as sent' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Mark not sent' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Write a new version…' })).toBeNull();
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

  it('does not put <null> in the Approve heading', async () => {
    api.proposal.mockResolvedValue({ ...review, status: 'draft', stop_reason: null, error: null, to_name: null, to_email: 'test+a@peak.test', versions: [] });
    const named = render(<ProposalDrawer id={9} onClose={() => {}} bump={() => {}} openLead={() => {}} openProposal={() => {}} />);
    await userEvent.click(await screen.findByRole('button', { name: 'Approve and send' }));
    expect(screen.getByRole('alertdialog', { name: 'Confirm send' })).toHaveTextContent('Send to test+a@peak.test?');
    expect(screen.queryByText(/<null>/)).toBeNull();
    named.unmount();

    api.proposal.mockResolvedValue({ ...review, status: 'draft', stop_reason: null, error: null, to_name: 'Dana', to_email: null, versions: [] });
    render(<ProposalDrawer id={9} onClose={() => {}} bump={() => {}} openLead={() => {}} openProposal={() => {}} />);
    expect(await screen.findByRole('button', { name: 'Approve and send' })).toBeDisabled();
    expect(screen.queryByText(/<null>/)).toBeNull();
  });
});
