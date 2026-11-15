import { beforeEach, describe, expect, it } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { api } from '../api';
import { foundLead } from '../test/fixtures.js';
import { installApiDefaults } from '../test/defaults.js';
import { timeAgo } from '../ui';
import LeadDrawer from './LeadDrawer';
import ProposalDrawer from './ProposalDrawer';
import Proposals from './Proposals';

const LAST = '2026-11-14T21:14:00.000Z';
const SINCE = '2026-11-15T13:03:00.000Z';
const shared = { version: 1, bump: () => {}, openProposal: () => {}, openLead: () => {}, openProject: () => {} };

const sentAt = new Date(Date.now() - (5 * 86400000 + 3 * 3600000)).toISOString();
const legacyViewedAt = new Date(Date.now() - (20 * 3600000 + 30 * 60000)).toISOString();

function sent(extra = {}) {
  return {
    id: 21,
    prospect_id: 11,
    company: 'TEST: Wasatch Heating',
    industry: 'HVAC',
    city: 'Provo',
    to_email: 'test+owner@example.test',
    to_name: 'Sam',
    subject: 'Missed after-hours calls',
    status: 'sent',
    fit_score: 86,
    fit_tier: 'A',
    fit_verdict: 'strong',
    reviewed_at: sentAt,
    version: 1,
    cost_usd: 0.12,
    views: 9,
    last_viewed_at: legacyViewedAt,
    sent_at: sentAt,
    followup1_sent_at: sentAt,
    followup2_sent_at: sentAt,
    onepager_url: 'https://example.test/p/wasatch',
    created_at: sentAt,
    updated_at: sentAt,
    analysis: {},
    versions: [{ id: 21, version: 1, status: 'sent' }],
    body: 'Hi',
    followup1: 'One',
    followup2: 'Two',
    ...extra,
  };
}

function counts(extra) {
  return {
    prospect_views: null,
    last_prospect_view_at: null,
    internal_views: null,
    counting_since: null,
    ...extra,
  };
}

const legacyLine = () => `Sent ${timeAgo(sentAt)} · both follow-ups sent · one-pager opened 9×`;
const legacyDrawer = () => `One-pager opened 9×, last ${timeAgo(legacyViewedAt)}. Email scanners can trigger a view, so treat this as a hint.`;

beforeEach(() => { installApiDefaults(); });

function showList(rows) {
  api.proposals.mockImplementation(async (filters = {}) => {
    if (filters.prospect_id) return { proposals: rows.filter((row) => row.prospect_id === filters.prospect_id) };
    if (filters.view && filters.view !== 'out' && filters.view !== 'review') return { proposals: [] };
    return { proposals: rows };
  });
  window.location.hash = '#/proposals?tab=out';
  return render(<Proposals {...shared} />);
}

describe('prospect views in the CRM', () => {
  it('keeps the list, drawer, and lead view on the flag-off wording', async () => {
    const row = sent();
    showList([row]);
    expect(await screen.findByText(legacyLine())).toBeInTheDocument();
    expect(screen.queryByText(/Prospect views/)).toBeNull();
    expect(screen.queryByText(/Team\/scanner/)).toBeNull();
    expect(screen.queryByText(/not tracked/)).toBeNull();

    api.proposal.mockResolvedValue(row);
    const drawer = render(<ProposalDrawer id={21} onClose={() => {}} {...shared} />);
    expect(await screen.findByText(legacyDrawer())).toBeInTheDocument();
    expect(screen.queryByText(/Prospect views/)).toBeNull();
    expect(screen.queryByText(/Team\/scanner/)).toBeNull();
    expect(screen.queryByText(/not tracked/)).toBeNull();
    drawer.unmount();

    api.prospect.mockResolvedValue({ ...foundLead, id: 11, company: row.company });
    api.proposals.mockResolvedValue({ proposals: [row] });
    render(<LeadDrawer id={11} onClose={() => {}} {...shared} />);
    const block = (await screen.findByRole('heading', { name: 'Proposal' })).closest('section');
    expect(block).toHaveTextContent('“Missed after-hours calls”');
    expect(block).toHaveTextContent(`v1 · $0.12 · sent ${timeAgo(sentAt)}`);
    expect(block).not.toHaveTextContent('Prospect views');
    expect(block).not.toHaveTextContent('Team/scanner');
    expect(block).not.toHaveTextContent('not tracked');
    expect(block).not.toHaveTextContent('one-pager opened');
  });

  it('shows prospect, team, untracked, and team-only rows without the legacy count', async () => {
    const tracked = sent(counts({
      id: 21,
      prospect_views: 2,
      internal_views: 3,
      last_prospect_view_at: LAST,
      counting_since: SINCE,
    }));
    const quiet = sent(counts({
      id: 22,
      prospect_id: 12,
      company: 'TEST: Peak Plumbing',
      subject: 'Estimate follow-up',
      views: 4,
      counting_since: SINCE,
    }));
    const team = sent(counts({
      id: 23,
      prospect_id: 13,
      company: 'TEST: Bonneville Air',
      subject: 'Booking link',
      views: 3,
      prospect_views: 0,
      internal_views: 5,
      counting_since: SINCE,
    }));
    const zeros = sent(counts({
      id: 24,
      prospect_id: 14,
      company: 'TEST: Alpine Comfort',
      subject: 'Quiet week',
      views: 8,
      prospect_views: 0,
      internal_views: 0,
      counting_since: SINCE,
    }));
    showList([tracked, quiet, team, zeros]);

    const wasatch = (await screen.findByRole('button', { name: /TEST: Wasatch Heating/ }));
    expect(within(wasatch).getByText(/Prospect views 2/, { selector: '.prospect-views-main' })).toHaveTextContent('last Nov 14, 2026, 2:14 PM MT');
    expect(within(wasatch).getByText('Team/scanner views 3')).toBeInTheDocument();
    expect(within(wasatch).queryByText(/one-pager opened/)).toBeNull();
    expect(within(wasatch).queryByText(/9×/)).toBeNull();

    const peak = screen.getByRole('button', { name: /TEST: Peak Plumbing/ });
    expect(within(peak).getByText('Prospect views: not tracked')).toBeInTheDocument();
    expect(within(peak).getByText('counting since Nov 15, 2026, 6:03 AM MT')).toBeInTheDocument();
    expect(within(peak).queryByText(/Team\/scanner/)).toBeNull();
    expect(within(peak).queryByText(/one-pager opened/)).toBeNull();

    const bonneville = screen.getByRole('button', { name: /TEST: Bonneville Air/ });
    expect(within(bonneville).getByText('Prospect views 0')).toBeInTheDocument();
    expect(within(bonneville).getByText('Team/scanner views 5')).toBeInTheDocument();
    expect(within(bonneville).queryByText(/last /)).toBeNull();

    const alpine = screen.getByRole('button', { name: /TEST: Alpine Comfort/ });
    expect(within(alpine).getByText('Prospect views 0')).toBeInTheDocument();
    expect(within(alpine).getByText('Team/scanner views 0')).toBeInTheDocument();
  });

  it('uses the new counts in the drawer and on the lead, including a draft', async () => {
    const row = sent(counts({
      prospect_views: 2,
      internal_views: 3,
      last_prospect_view_at: LAST,
      counting_since: SINCE,
    }));
    api.proposal.mockResolvedValue(row);
    const drawer = render(<ProposalDrawer id={21} onClose={() => {}} {...shared} />);
    const views = await screen.findByText(/Prospect views 2/, { selector: '.prospect-views-main' });
    expect(views).toHaveTextContent('last Nov 14, 2026, 2:14 PM MT');
    expect(screen.getByText('Team/scanner views 3')).toBeInTheDocument();
    expect(screen.queryByText(/One-pager opened/)).toBeNull();
    expect(screen.queryByText(/Email scanners can trigger/)).toBeNull();
    expect(screen.queryByText(/9×/)).toBeNull();
    drawer.unmount();

    const unseen = sent(counts({
      prospect_views: null,
      internal_views: null,
      counting_since: null,
    }));
    api.proposal.mockResolvedValue(unseen);
    const blank = render(<ProposalDrawer id={21} onClose={() => {}} {...shared} />);
    expect(await screen.findByText('Prospect views: not tracked')).toBeInTheDocument();
    expect(screen.queryByText(/counting since/)).toBeNull();
    expect(screen.queryByText(/One-pager opened/)).toBeNull();
    blank.unmount();

    api.markProposalSeen.mockResolvedValue({ ok: true });
    api.proposal.mockResolvedValue({
      ...sent(counts({ prospect_views: 0, internal_views: 0, counting_since: SINCE })),
      status: 'draft',
      sent_at: null,
      reviewed_at: null,
    });
    const draft = render(<ProposalDrawer id={21} onClose={() => {}} {...shared} />);
    expect(await screen.findByText('Prospect views 0')).toBeInTheDocument();
    expect(screen.getByText('Team/scanner views 0')).toBeInTheDocument();
    expect(screen.queryByText(/One-pager opened/)).toBeNull();
    draft.unmount();

    api.prospect.mockResolvedValue({ ...foundLead, id: 11, company: row.company });
    api.proposals.mockResolvedValue({ proposals: [row] });
    render(<LeadDrawer id={11} onClose={() => {}} {...shared} />);
    const block = (await screen.findByRole('heading', { name: 'Proposal' })).closest('section');
    expect(block).toHaveTextContent('Prospect views 2');
    expect(block).toHaveTextContent('last Nov 14, 2026, 2:14 PM MT');
    expect(block).toHaveTextContent('Team/scanner views 3');
    expect(block).toHaveTextContent(`sent ${timeAgo(sentAt)}`);
    expect(block).not.toHaveTextContent('one-pager opened');
    expect(block).not.toHaveTextContent('9×');
  });
});
