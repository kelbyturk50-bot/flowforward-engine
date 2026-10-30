import fs from 'fs';
import path from 'path';
import { beforeEach, describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { api } from '../api';
import { installApiDefaults } from '../test/defaults.js';
import ProposalDrawer from './ProposalDrawer';

const base = {
  id: 9, prospect_id: 3, version: 1, status: 'draft', company: 'TEST: Peak Plumbing', subject: 'ideas',
  body: 'Hi,\n\n{{ONEPAGER_URL}}\n\nKelby', followup1: 'One more idea.\n\nKelby', followup2: 'Closing the loop.',
  to_email: 'test+a@peak.test', analysis: {}, versions: [], preview: {}, onepager_url: 'https://api.test/p/x',
  updated_at: '2026-10-20T00:00:00Z', created_at: '2026-10-20T00:00:00Z',
};
const props = { id: 9, onClose: () => {}, bump: () => {}, openLead: () => {}, openProposal: () => {} };

beforeEach(() => { installApiDefaults(); });

describe('mark as sent needs a recipient', () => {
  it('puts the helper on its own line under the buttons', () => {
    const css = fs.readFileSync(path.resolve('src/styles.css'), 'utf8');
    const block = css.match(/\.action-bar \.recipient-hint \{[^}]*\}/)[0];
    expect(block).toMatch(/flex:\s*1 0 100%/);
    expect(block).toMatch(/display:\s*flex/);
    expect(block).toMatch(/align-items:\s*center/);
    expect(block).toMatch(/min-height:\s*44px/);
  });

  it('disables both send buttons and shows why when to_email is missing', async () => {
    for (const toEmail of [null, '', '   ', '\t']) {
      api.proposal.mockResolvedValue({ ...base, to_email: toEmail });
      const view = render(<ProposalDrawer {...props} />);
      const mark = await screen.findByRole('button', { name: 'Mark as manually sent…' });
      const approve = screen.getByRole('button', { name: 'Approve and send' });
      expect(mark).toBeDisabled();
      expect(approve).toBeDisabled();
      expect(mark).toHaveAttribute('title', 'Add a recipient email first');
      expect(approve).toHaveAttribute('title', 'Add a recipient email first');
      const hint = screen.getByRole('button', { name: 'Add a recipient email first' });
      expect(hint).toHaveClass('recipient-hint');
      expect(screen.queryByRole('alertdialog', { name: 'Confirm manual send' })).toBeNull();
      hint.click();
      expect(document.getElementById('proposal-to-email')).toHaveFocus();
      view.unmount();
    }
  });

  it('asks to fix an address that is present but not usable', async () => {
    for (const toEmail of ['kelby', 'test+\u206Aa@example.com', 'test+\u0001a@example.com']) {
      api.proposal.mockResolvedValue({ ...base, to_email: toEmail });
      const view = render(<ProposalDrawer {...props} />);
      const mark = await screen.findByRole('button', { name: 'Mark as manually sent…' });
      const approve = screen.getByRole('button', { name: 'Approve and send' });
      expect(mark).toBeDisabled();
      expect(approve).toBeDisabled();
      expect(mark).toHaveAttribute('title', 'Fix the recipient email');
      expect(approve).toHaveAttribute('title', 'Fix the recipient email');
      expect(screen.getByRole('button', { name: 'Fix the recipient email' })).toBeInTheDocument();
      expect(screen.queryByText('Add a recipient email first')).toBeNull();
      view.unmount();
    }
  });

  it('saves a trailing space in To when the field blurs', async () => {
    api.proposal.mockResolvedValue({ ...base, to_email: 'test+a@peak.test ' });
    api.updateProposal.mockResolvedValue({ ...base, to_email: 'test+a@peak.test' });
    render(<ProposalDrawer {...props} />);
    const input = await screen.findByLabelText('To (email)');
    expect(screen.getByRole('button', { name: 'Fix the recipient email' })).toBeInTheDocument();
    input.focus();
    await userEvent.tab();
    expect(api.updateProposal).toHaveBeenCalledWith(9, { to_email: 'test+a@peak.test' });
  });

  it('enables both buttons when a recipient email is present', async () => {
    api.proposal.mockResolvedValue({ ...base, to_email: 'test+a@peak.test' });
    render(<ProposalDrawer {...props} />);
    const mark = await screen.findByRole('button', { name: 'Mark as manually sent…' });
    expect(mark).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Approve and send' })).toBeEnabled();
    expect(screen.queryByText('Add a recipient email first')).toBeNull();
    await userEvent.click(mark);
    expect(screen.getByRole('alertdialog', { name: 'Confirm manual send' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Yes, mark as sent' })).toBeEnabled();
  });
});
