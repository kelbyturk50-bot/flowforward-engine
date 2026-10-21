import { beforeEach, describe, expect, it } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { api } from '../api';
import { installApiDefaults } from '../test/defaults.js';
import Inbox from './Inbox';

const shared = { version: 0, bump: () => {}, openLead: () => {}, openProject: () => {}, openProposal: () => {} };

const listItem = {
  id: 7, prospect_id: 3, proposal_id: 9, status: 'ready', kind: 'interested', label: 'Interested · wants a call',
  company: 'TEST: Wasatch Heating', contact_name: 'Dana Reyes', from_addr: 'test+dana@wasatch.test',
  preview: 'Does this work with Housecall Pro?', received_at: new Date().toISOString(), reviewed_at: null, fit_score: 88, fit_tier: 'A',
};
const detail = {
  ...listItem, summary: 'Wants to talk this week.', asks: ['Does it work with Housecall Pro?', 'What does it cost?'],
  timing: 'Tue or Wed', mood: 'Warm', prep: [], applied: {},
  suggestions: [{ action: 'set_stage', stage: 'qualified', label: 'Move to Qualified' }],
  reply_to: 'test+dana@wasatch.test', reply_subject: 'Re: Quick idea',
  reply_body: 'Hi Dana,\n\nCost: [YOUR PRICING ANSWER]\n\nKelby',
  thread: [
    { who: 'You', direction: 'out', at: new Date(Date.now() - 86400000).toISOString(), subject: 'Quick idea', body: 'Hi Dana, first email', source: 'proposal' },
    { who: 'test+dana@wasatch.test', direction: 'in', at: new Date().toISOString(), subject: 'Re: Quick idea', body: 'Does this work with Housecall Pro?', source: 'message' },
  ],
};

beforeEach(() => {
  installApiDefaults();
  window.location.hash = '#/inbox';
  api.inbox.mockResolvedValue({ items: [listItem], counts: { needs: 1, fyi: 0, handled: 0, working: 0, waiting: 1 } });
  api.inboxItem.mockResolvedValue(detail);
  api.updateInboxItem.mockResolvedValue({});
  api.sendInboxReply.mockResolvedValue({ ...detail, status: 'sent' });
  api.applyInboxSuggestion.mockResolvedValue({});
});

describe('Inbox', () => {
  it("shows Claude's read, the thread and the draft", async () => {
    render(<Inbox {...shared} />);
    expect(await screen.findByRole('heading', { name: 'Inbox' })).toBeInTheDocument();
    expect(await screen.findByText('Wants to talk this week.')).toBeInTheDocument();
    expect(screen.getByText('What does it cost?')).toBeInTheDocument();
    expect(screen.getByText('Does this work with Housecall Pro?', { selector: '.imsg-text' })).toBeInTheDocument();
    expect(screen.getByLabelText('Reply text')).toHaveValue(detail.reply_body);
    expect(api.markInboxSeen).toHaveBeenCalledWith(7);
  });

  it('blocks Send until every placeholder is filled, then sends', async () => {
    const user = userEvent.setup();
    render(<Inbox {...shared} />);
    const send = await screen.findByRole('button', { name: 'Send reply' });
    expect(send).toBeDisabled();
    expect(screen.getByText('[YOUR PRICING ANSWER]', { selector: 'code' })).toBeInTheDocument();

    const box = screen.getByLabelText('Reply text');
    await user.clear(box);
    await user.type(box, 'Hi Dana, it depends on setup. Kelby');
    expect(send).toBeEnabled();
    await user.click(send);
    expect(api.updateInboxItem).toHaveBeenCalledWith(7, { reply_body: 'Hi Dana, it depends on setup. Kelby' });
    expect(api.sendInboxReply).toHaveBeenCalledWith(7);
  });

  it('applies a suggested next step with one click', async () => {
    const user = userEvent.setup();
    render(<Inbox {...shared} />);
    const chip = await screen.findByRole('button', { name: 'Move to Qualified' });
    await user.click(chip);
    expect(api.applyInboxSuggestion).toHaveBeenCalledWith(7, 0);
  });

  it('shows an empty state when nothing is waiting', async () => {
    api.inbox.mockResolvedValue({ items: [], counts: { needs: 0, fyi: 0, handled: 0 } });
    render(<Inbox {...shared} />);
    expect(await screen.findByText(/No replies waiting/)).toBeInTheDocument();
    const tabs = screen.getByRole('tablist', { name: 'Inbox filter' });
    expect(within(tabs).getAllByRole('tab')).toHaveLength(3);
  });
});
