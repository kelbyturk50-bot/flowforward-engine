import { beforeEach, describe, expect, it } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { api } from '../api';
import { installApiDefaults } from '../test/defaults.js';
import ChatFactsPanel from './ChatFactsPanel';

const proposedHours = {
  field: 'hours', value: 'Monday–Friday: 8:00 AM – 5:00 PM', source: 'cached_research',
  source_url: 'https://maps.google.com/?cid=1', snippet: 'Monday: 8:00 AM – 5:00 PM', per_google: true,
  review_status: 'proposed', test_tag: 'demo-prototype',
};
const proposedServices = {
  field: 'services', value: 'Furnace Repair, AC Repair', source: 'cached_research',
  source_url: 'https://www.lonepeak.example/', snippet: 'Furnace Repair, AC Repair and Water Heaters.', per_google: false,
  review_status: 'proposed', test_tag: 'demo-prototype',
};
const approved = (fact) => ({ ...fact, review_status: 'approved' });

beforeEach(() => { installApiDefaults(); });

describe('ChatFactsPanel', () => {
  it('reads facts from research and shows each with its source', async () => {
    api.buildChatFacts.mockResolvedValue({ facts: [proposedHours, proposedServices], proposed: 2 });
    render(<ChatFactsPanel prospectId={7} />);
    expect(await screen.findByText(/No facts yet/)).toBeInTheDocument();
    expect(api.chatFacts).toHaveBeenCalledWith(7);
    await userEvent.click(screen.getByRole('button', { name: 'Read from research' }));
    expect(api.buildChatFacts).toHaveBeenCalledWith(7);
    const items = await screen.findAllByRole('listitem');
    expect(items).toHaveLength(2);
    expect(within(items[0]).getByText('Hours')).toBeInTheDocument();
    expect(within(items[0]).getByRole('link', { name: 'per Google' })).toHaveAttribute('href', proposedHours.source_url);
    expect(within(items[1]).getByRole('link', { name: 'lonepeak.example' })).toBeInTheDocument();
    expect(screen.getAllByText('Needs review')).toHaveLength(2);
    expect(screen.getByRole('button', { name: 'Approve all (2)' })).toBeInTheDocument();
  });

  it('approves one fact, then all, and removes a fact', async () => {
    api.chatFacts.mockResolvedValue({ facts: [proposedHours, proposedServices] });
    api.approveChatFacts.mockImplementation(async (id, fields) => ({
      facts: fields ? [approved(proposedHours), proposedServices] : [approved(proposedHours), approved(proposedServices)],
    }));
    api.removeChatFact.mockResolvedValue({ facts: [approved(proposedHours)] });
    render(<ChatFactsPanel prospectId={7} />);
    await userEvent.click(await screen.findByRole('button', { name: 'Approve Hours' }));
    expect(api.approveChatFacts).toHaveBeenCalledWith(7, ['hours']);
    expect(await screen.findByRole('button', { name: 'Approve all (1)' })).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Approve all (1)' }));
    expect(api.approveChatFacts).toHaveBeenLastCalledWith(7);
    expect(screen.queryByText('Needs review')).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Remove Services' }));
    expect(api.removeChatFact).toHaveBeenCalledWith(7, 'services');
    expect(await screen.findAllByRole('listitem')).toHaveLength(1);
  });

  it('says what to do when no research is saved', async () => {
    api.buildChatFacts.mockRejectedValue(Object.assign(new Error('no_research'), { status: 409 }));
    render(<ChatFactsPanel prospectId={7} />);
    await userEvent.click(await screen.findByRole('button', { name: 'Read from research' }));
    expect(await screen.findByText('No research is saved for this lead yet. Draft a proposal first, then read again.')).toBeInTheDocument();
  });
});
