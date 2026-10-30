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
  it('disables the button and shows why when to_email is missing', async () => {
    for (const toEmail of [null, '', '   ', '\t']) {
      api.proposal.mockResolvedValue({ ...base, to_email: toEmail });
      const view = render(<ProposalDrawer {...props} />);
      const button = await screen.findByRole('button', { name: 'Mark as manually sent…' });
      expect(button).toBeDisabled();
      expect(button).toHaveAttribute('title', 'Add a recipient email first');
      expect(screen.getByText('Add a recipient email first')).toBeInTheDocument();
      expect(screen.queryByRole('alertdialog', { name: 'Confirm manual send' })).toBeNull();
      view.unmount();
    }
  });

  it('enables the button when a recipient email is present', async () => {
    api.proposal.mockResolvedValue({ ...base, to_email: 'test+a@peak.test' });
    render(<ProposalDrawer {...props} />);
    const button = await screen.findByRole('button', { name: 'Mark as manually sent…' });
    expect(button).toBeEnabled();
    expect(screen.queryByText('Add a recipient email first')).toBeNull();
    await userEvent.click(button);
    expect(screen.getByRole('alertdialog', { name: 'Confirm manual send' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Yes, mark as sent' })).toBeEnabled();
  });
});
