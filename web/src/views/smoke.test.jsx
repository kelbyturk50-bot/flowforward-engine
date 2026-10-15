import { beforeEach, describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import App from '../App';
import { settings } from '../api';
import { installApiDefaults } from '../test/defaults.js';
import Today from './Today';
import Leads from './Leads';
import Proposals from './Proposals';
import Pipeline from './Pipeline';
import Projects from './Projects';
import Settings from './Settings';

const shared = {
  version: 0,
  bump: () => {},
  openLead: () => {},
  openProject: () => {},
  openProposal: () => {},
};

beforeEach(() => {
  installApiDefaults();
});

describe('CRM views', () => {
  it('renders Today with the mocked queue', async () => {
    render(<Today {...shared} />);
    expect(await screen.findByRole('heading', { name: /Good (morning|afternoon|evening), Kelby/ })).toBeInTheDocument();
    expect(await screen.findByRole('button', { name: 'Open Wasatch Air Co' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Open Peak Plumbing' })).toBeInTheDocument();
    expect(screen.getByText('Kickoff call')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Follow-ups due' })).toBeInTheDocument();
  });

  it('renders Leads with the mocked list', async () => {
    render(<Leads {...shared} />);
    expect(await screen.findByRole('heading', { name: 'Leads' })).toBeInTheDocument();
    expect(await screen.findByText('Wasatch Air Co')).toBeInTheDocument();
    expect(screen.getByText(/1 match/)).toBeInTheDocument();
  });

  it('renders Proposals and switches tabs', async () => {
    const user = userEvent.setup();
    render(<Proposals {...shared} />);
    expect(await screen.findByRole('heading', { name: 'Proposals' })).toBeInTheDocument();
    expect(await screen.findByText(/After-hours calls/)).toBeInTheDocument();
    expect(screen.getByText(/2 A-tier leads without a proposal/)).toBeInTheDocument();

    await user.click(screen.getByRole('tab', { name: /^Out/ }));
    expect(screen.getByRole('tab', { name: /^Out/ })).toHaveAttribute('aria-selected', 'true');
    expect(await screen.findByText('Nothing here yet.')).toBeInTheDocument();
    expect(screen.getByText(/Sent\. Follow-ups go out on day 3/)).toBeInTheDocument();
  });

  it('renders Pipeline columns from mocked stages', async () => {
    render(<Pipeline {...shared} />);
    expect(await screen.findByRole('heading', { name: 'Pipeline' })).toBeInTheDocument();
    expect(await screen.findByText('Wasatch Air Co')).toBeInTheDocument();
    expect(screen.getByText('Peak Plumbing')).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Found' })).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Contacted' })).toBeInTheDocument();
  });

  it('renders Projects', async () => {
    render(<Projects {...shared} />);
    expect(await screen.findByRole('heading', { name: 'Projects' })).toBeInTheDocument();
    expect(await screen.findByText('After-hours intake')).toBeInTheDocument();
    expect(screen.getByText('Active')).toBeInTheDocument();
  });

  it('renders Settings from the mocked connection, without a production URL', async () => {
    render(<Settings {...shared} onSaved={() => {}} />);
    expect(await screen.findByRole('heading', { name: 'Settings' })).toBeInTheDocument();
    const address = screen.getByLabelText('API address');
    expect(address).toHaveValue('http://127.0.0.1:3000');
    expect(address.value).not.toMatch(/railway|production/i);
    expect(settings.apiKey).toBe('test-key');
    expect(await screen.findByRole('heading', { name: 'Lead discovery' })).toBeInTheDocument();
    expect(screen.getByText('completed')).toBeInTheDocument();
    expect(await screen.findByRole('heading', { name: 'Proposal bot' })).toBeInTheDocument();
    expect(screen.getByText(/sender@example\.test/)).toBeInTheDocument();
  });

  it('opens the add-lead drawer', async () => {
    const user = userEvent.setup();
    render(<Leads {...shared} />);
    await user.click(await screen.findByRole('button', { name: 'Add lead' }));
    expect(screen.getByRole('dialog', { name: 'Add lead' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Add a lead' })).toBeInTheDocument();
  });

  it('opens a lead drawer from the leads list', async () => {
    const user = userEvent.setup();
    window.location.hash = '#/leads';
    render(<App />);
    await user.click(await screen.findByText('Wasatch Air Co'));
    const dialog = await screen.findByRole('dialog', { name: 'Wasatch Air Co' });
    expect(dialog).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Wasatch Air Co' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Mark won and start project' })).toBeInTheDocument();
  });

  it('refuses to call the network', () => {
    expect(() => fetch('http://127.0.0.1:9/health')).toThrow(/must not call fetch/);
  });
});
