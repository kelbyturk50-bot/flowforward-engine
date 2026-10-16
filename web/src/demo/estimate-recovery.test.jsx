import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { api } from '../api';
import { installApiDefaults } from '../test/defaults.js';
import { proposal } from '../test/fixtures.js';
import DemoGate from './DemoGate';
import ProposalDrawer from '../views/ProposalDrawer';
import Proposals from '../views/Proposals';
import { OPEN_ESTIMATES, OPEN_TOTAL, RECOVERED, buildDemo } from './fixture.js';

const TOKEN = 'demo-example-heating-air';
const SHORT = 'a'.repeat(21);

const shared = {
  version: 0,
  bump: () => {},
  openLead: () => {},
  openProject: () => {},
  openProposal: () => {},
  onClose: () => {},
};

function at(path) {
  window.history.pushState({}, '', path);
}

describe('estimate recovery demo', () => {
  let fetchMock;
  let downloads;
  let createObjectURL;
  let anchorClick;

  beforeEach(() => {
    installApiDefaults();
    fetchMock = vi.fn(() => {
      throw new Error('Tests must not call fetch.');
    });
    vi.stubGlobal('fetch', fetchMock);
    downloads = [];
    createObjectURL = vi.fn(() => 'blob:estimate-recovery-demo');
    vi.stubGlobal('URL', Object.assign(URL, {
      createObjectURL,
      revokeObjectURL: vi.fn(),
    }));
    anchorClick = HTMLAnchorElement.prototype.click;
    HTMLAnchorElement.prototype.click = function click() {
      if (this.download) downloads.push({ download: this.download, href: this.href });
    };
  });

  afterEach(() => {
    HTMLAnchorElement.prototype.click = anchorClick;
    vi.stubGlobal('fetch', () => {
      throw new Error('Tests must not call fetch. The API client is mocked.');
    });
  });

  it('shows not-found and no demo CTA when the master flag is off', async () => {
    at(`/demo/estimate-recovery/${TOKEN}`);
    render(<DemoGate token={TOKEN} />);
    expect(screen.getByRole('heading', { name: 'Page not found' })).toBeInTheDocument();
    expect(screen.queryByText(/nothing is sent/i)).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Try a live demo' })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Preview demo' })).not.toBeInTheDocument();
    expect(document.querySelector('meta[name="robots"]')).toHaveAttribute('content', 'noindex');

    at('/#/proposals');
    render(<Proposals {...shared} />);
    expect(await screen.findByRole('heading', { name: 'Proposals' })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Try a live demo' })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Preview demo' })).not.toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('shows not-found for a token that is not base64url of 22 to 64 characters', () => {
    at(`/?flags=FF_PILOT_ESTIMATE_RECOVERY`);
    const { rerender } = render(<DemoGate token={SHORT} />);
    expect(screen.getByRole('heading', { name: 'Page not found' })).toBeInTheDocument();
    rerender(<DemoGate token={'bad+token+padding+aaaa'} />);
    expect(screen.getByRole('heading', { name: 'Page not found' })).toBeInTheDocument();
    expect(screen.queryByText(/38,400/)).not.toBeInTheDocument();
  });

  it('shows the demo for base64url tokens of 22 and 64 characters and not-found outside that range', async () => {
    at(`/?flags=FF_PILOT_ESTIMATE_RECOVERY`);
    const cases = [
      [21, false],
      [22, true],
      [64, true],
      [65, false],
      [100000, false],
    ];
    const { rerender } = render(<DemoGate token={'a'.repeat(21)} />);
    for (const [length, valid] of cases) {
      rerender(<DemoGate token={'a'.repeat(length)} />);
      if (valid) {
        expect(await screen.findByRole('heading', { name: 'Example Heating & Air: 3 open estimates, $38,400' })).toBeInTheDocument();
      } else {
        expect(screen.getByRole('heading', { name: 'Page not found' })).toBeInTheDocument();
        expect(screen.queryByText(/38,400/)).not.toBeInTheDocument();
      }
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('walks the four steps with sample data and zero fetch calls', async () => {
    const user = userEvent.setup();
    at(`/demo/estimate-recovery/${TOKEN}?flags=FF_PILOT_ESTIMATE_RECOVERY`);
    render(<DemoGate token={TOKEN} />);

    expect(await screen.findByRole('heading', { name: 'Example Heating & Air: 3 open estimates, $38,400' })).toBeInTheDocument();
    expect(screen.getByText('Furnace replacement')).toBeInTheDocument();
    expect(screen.getByText('Good $9,800')).toBeInTheDocument();
    expect(screen.getByText('Better $14,800')).toBeInTheDocument();
    expect(screen.getByText('Best $19,600')).toBeInTheDocument();
    expect(screen.getByText('AC replacement')).toBeInTheDocument();
    expect(screen.getByText('$16,400')).toBeInTheDocument();
    expect(screen.getByText('Duct job')).toBeInTheDocument();
    expect(screen.getByText('$7,200')).toBeInTheDocument();
    expect(screen.getAllByText(/fictional/i).length).toBeGreaterThan(0);

    await user.click(screen.getByRole('button', { name: 'Send estimate' }));
    expect(screen.getByRole('heading', { name: 'Preview — nothing is sent' })).toBeInTheDocument();
    expect(await screen.findByRole('heading', { name: 'Thank you' })).toBeInTheDocument();
    expect(await screen.findByRole('heading', { name: 'Answers to common questions' }, { timeout: 3000 })).toBeInTheDocument();
    expect(await screen.findByRole('heading', { name: 'Call now (opened 3×)' }, { timeout: 3000 })).toBeInTheDocument();
    expect(await screen.findByRole('heading', { name: 'Close the loop' }, { timeout: 3000 })).toBeInTheDocument();
    expect(screen.getAllByText(/From Example Heating & Air/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/nothing is sent/i).length).toBeGreaterThan(0);

    const next = screen.getByRole('button', { name: 'See the homeowner reply' });
    await waitFor(() => expect(next).toBeEnabled());
    await user.click(next);

    expect(screen.getByRole('heading', { name: 'Is there financing?' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Draft awaiting owner approval' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Approve reply' }));
    expect(screen.getByText('Approved → schedule install')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'See the owner summary' }));
    expect(screen.getByRole('heading', { name: 'Recovered: $14,800. You own this workflow.' })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Export sample data (JSON)' }));
    await waitFor(() => expect(downloads).toEqual([
      expect.objectContaining({ download: 'estimate-recovery-demo.json' }),
    ]));
    expect(createObjectURL).toHaveBeenCalled();
    const blob = createObjectURL.mock.calls[0][0];
    const exported = JSON.parse(await blob.text());
    expect(exported.synthetic).toBe(true);
    expect(exported.company).toBe('Example Heating & Air');
    expect(exported.openTotal).toBe(38400);
    expect(exported.recovered).toBe(14800);
    expect(exported.disclaimer).toMatch(/nothing was sent/i);
    expect(JSON.stringify(exported)).not.toMatch(/@|sms|twilio/i);

    expect(fetchMock).not.toHaveBeenCalled();
    for (const fn of Object.values(api)) expect(fn).not.toHaveBeenCalled();
    expect(screen.queryByText(/sms|twilio|missed call/i)).not.toBeInTheDocument();
    expect(document.querySelector('meta[name="robots"]')).toHaveAttribute('content', 'noindex');
  });

  it('uses a ?company= override on an allowed host', async () => {
    at(`/demo/estimate-recovery/${TOKEN}?flags=FF_PILOT_ESTIMATE_RECOVERY&company=Sample%20Heating%20Co`);
    render(<DemoGate token={TOKEN} />);
    expect(await screen.findByRole('heading', { name: 'Sample Heating Co: 3 open estimates, $38,400' })).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('renders company override text without executing it', async () => {
    at(`/demo/estimate-recovery/${TOKEN}?flags=FF_PILOT_ESTIMATE_RECOVERY&company=%3Cscript%3Ealert(1)%3C%2Fscript%3E`);
    const { container } = render(<DemoGate token={TOKEN} />);
    const heading = await screen.findByRole('heading', { level: 1 });
    expect(heading.textContent).toContain('<script>alert(1)</script>');
    expect(container.querySelector('h1 script')).toBeNull();
  });

  it('shows Preview demo for the master flag and the one-pager CTA only when both flags are on', async () => {
    at('/?flags=FF_PILOT_ESTIMATE_RECOVERY#/proposals');
    render(<Proposals {...shared} />);
    const preview = await screen.findByRole('link', { name: 'Preview demo' });
    const previewUrl = new URL(preview.getAttribute('href'), 'https://preview.example');
    expect(previewUrl.pathname).toBe(`/demo/estimate-recovery/${TOKEN}`);
    expect(previewUrl.searchParams.get('flags')).toBe('FF_PILOT_ESTIMATE_RECOVERY');
    expect(screen.queryByRole('link', { name: 'Try a live demo' })).not.toBeInTheDocument();

    api.proposal.mockResolvedValue({
      ...proposal,
      onepager_url: 'https://example.test/p/synthetic-slug',
      updated_at: '2026-10-16T00:00:00.000Z',
    });
    render(<ProposalDrawer id={proposal.id} {...shared} />);
    expect(await screen.findByRole('link', { name: 'Preview one-pager' })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Try a live demo' })).not.toBeInTheDocument();

    at('/?flags=FF_PILOT_ESTIMATE_RECOVERY,FF_PILOT_LINK_ON_ONEPAGER');
    render(<ProposalDrawer id={proposal.id} {...shared} />);
    const cta = await screen.findByRole('link', { name: 'Try a live demo' });
    const ctaUrl = new URL(cta.getAttribute('href'), 'https://preview.example');
    expect(ctaUrl.pathname).toBe(`/demo/estimate-recovery/${TOKEN}`);
    expect(ctaUrl.searchParams.get('flags')).toContain('FF_PILOT_LINK_ON_ONEPAGER');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('sample estimates', () => {
  it('splits the three open jobs so they total $38,400', () => {
    const demo = buildDemo();
    expect(demo.company).toBe('Example Heating & Air');
    expect(demo.estimates.map(item => item.amount).reduce((sum, amount) => sum + amount, 0)).toBe(OPEN_TOTAL);
    expect(demo.openTotal).toBe(38400);
    expect(demo.recovered).toBe(RECOVERED);
    expect(OPEN_ESTIMATES[0].options.map(option => option.amount)).toEqual([9800, 14800, 19600]);
    expect(demo.recovered).toBe(14800);
  });
});
