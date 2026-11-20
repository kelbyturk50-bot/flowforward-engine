import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { api } from '../api';
import { installApiDefaults } from '../test/defaults.js';
import { Toaster } from '../ui';
import { formatDenverDateTime } from '../live-chat/dates.js';
import { approveSendBody } from './approve-send.js';
import ProposalDrawer from './ProposalDrawer';
import Proposals from './Proposals';

const REPLIED_AT = '2026-09-22T15:04:00.000Z';
const SENTENCE = 'This lead replied to another proposal on Sep 22, 2026, 9:04 AM MT. Check that reply before sending again.';
const HELD_BACK = 'Confirm this send before it goes out again.';
const OTHER_409 = 'This version is sent; only drafts can be sent.';

const draft = {
  id: 9,
  prospect_id: 3,
  version: 2,
  status: 'draft',
  company: 'TEST: Wasatch Heating',
  industry: 'HVAC',
  city: 'Provo',
  subject: 'Missed after-hours calls',
  body: 'Hi Sam,\n\nA short note.\n\nKelby',
  followup1: 'Checking in.\n\nKelby',
  followup2: 'Last note.',
  to_email: 'test+owner@example.test',
  to_name: 'Sam',
  stop_reason: null,
  error: null,
  analysis: { fit_verdict: 'good' },
  versions: [],
  preview: {},
  onepager: { observations: ['Missed calls'], opportunities: ['Text-back'] },
  onepager_url: 'https://example.test/p/wasatch',
  updated_at: '2026-11-19T16:30:00.000Z',
  created_at: '2026-11-19T16:00:00.000Z',
  fit_score: 86,
  fit_tier: 'A',
  rating: 4.8,
  review_count: 80,
};

const sent = {
  ...draft,
  status: 'sent',
  sent_at: '2026-11-20T16:00:00.000Z',
  updated_at: '2026-11-20T16:00:00.000Z',
};

function recentReplyError(extra = {}) {
  return Object.assign(new Error('recent_reply'), {
    status: 409,
    code: 'recent_reply',
    sibling_proposal_id: 42,
    replied_at: REPLIED_AT,
    ...extra,
  });
}

function heldBackError() {
  return Object.assign(new Error(HELD_BACK), { status: 409 });
}

function renderDrawer(extra = {}) {
  const openProposal = vi.fn();
  const bump = vi.fn();
  const props = { id: 9, onClose: () => {}, bump, openLead: () => {}, openProposal, ...extra };
  const view = render(<><Toaster /><ProposalDrawer {...props} /></>);
  return { ...view, props, openProposal, bump, rerenderDrawer: (next) => view.rerender(<><Toaster /><ProposalDrawer {...props} {...next} /></>) };
}

async function openConfirm() {
  await userEvent.click(await screen.findByRole('button', { name: 'Approve and send' }));
  return screen.getByRole('alertdialog', { name: 'Confirm send' });
}

beforeEach(() => { installApiDefaults(); });

describe('approve recent-reply warning', () => {
  it('formats the Denver time the warning uses', () => {
    expect(formatDenverDateTime(REPLIED_AT)).toBe('Sep 22, 2026, 9:04 AM MT');
    expect(approveSendBody({ acknowledge: 'true', confirm: 'true' })).toBeUndefined();
    expect(approveSendBody({})).toBeUndefined();
    const both = approveSendBody({ confirm: true, acknowledge: true });
    expect(both).toEqual({ confirm: true, acknowledge_recent_reply: true });
    expect(both.confirm).toBe(true);
    expect(both.acknowledge_recent_reply).toBe(true);
  });

  it('shows the warning with the Denver date and a link, and not a toast', async () => {
    api.proposal.mockResolvedValue(draft);
    api.sendProposal.mockRejectedValue(recentReplyError());
    const { openProposal } = renderDrawer();
    const confirm = await openConfirm();
    expect(confirm).not.toHaveTextContent('Send anyway');
    await userEvent.click(within(confirm).getByRole('button', { name: 'Send it' }));

    const warning = await screen.findByRole('alert');
    expect(warning).toHaveClass('reply-warning');
    expect(warning).toHaveTextContent(SENTENCE);
    expect(warning).toHaveTextContent(formatDenverDateTime(REPLIED_AT));
    expect(screen.queryByRole('alertdialog', { name: 'Confirm send' })).toBeNull();
    expect(document.querySelector('.toast')).not.toHaveTextContent('recent_reply');
    expect(document.querySelector('.toast')).not.toHaveClass('show');
    const actions = [...warning.querySelector('.reply-warning-actions').querySelectorAll('button')];
    expect(actions.map((button) => button.textContent)).toEqual(['Open that proposal', 'Send anyway', 'Cancel']);
    expect(actions[0].className).toBe('btn');
    expect(actions[1].className).toBe('btn btn-quiet');
    expect(actions[2].className).toBe('btn btn-quiet');
    expect(warning).toHaveAttribute('tabindex', '-1');
    await waitFor(() => expect(warning).toHaveFocus());
    const link = actions[0];
    expect(link).not.toHaveAttribute('target');
    expect(link).not.toHaveClass('linklike');
    await userEvent.click(link);
    expect(openProposal).toHaveBeenCalledTimes(1);
    expect(openProposal).toHaveBeenCalledWith(42);
    expect(link.closest('a')).toBeNull();
  });

  it('moves focus to the warning panel when it replaces the confirm dialog', async () => {
    api.proposal.mockResolvedValue(draft);
    api.sendProposal.mockRejectedValue(recentReplyError());
    renderDrawer();
    await openConfirm();
    await userEvent.click(screen.getByRole('button', { name: 'Send it' }));
    const warning = await screen.findByRole('alert');
    expect(warning).toHaveAttribute('tabindex', '-1');
    expect(screen.queryByRole('alertdialog', { name: 'Confirm send' })).toBeNull();
    await waitFor(() => expect(warning).toHaveFocus());
  });

  it('opens the sibling proposal in the same drawer', async () => {
    api.proposal.mockResolvedValue(draft);
    api.sendProposal.mockRejectedValue(recentReplyError());
    const { openProposal, rerenderDrawer } = renderDrawer();
    await openConfirm();
    await userEvent.click(screen.getByRole('button', { name: 'Send it' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Open that proposal' }));
    expect(openProposal).toHaveBeenCalledWith(42);

    api.proposal.mockResolvedValue({
      ...draft,
      id: 42,
      company: 'TEST: Peak Plumbing',
      subject: 'Earlier note',
      status: 'replied',
      replied_at: REPLIED_AT,
    });
    rerenderDrawer({ id: 42 });
    expect(await screen.findByRole('heading', { name: 'TEST: Peak Plumbing' })).toBeInTheDocument();
    expect(screen.getByDisplayValue('Earlier note')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(api.sendProposal).toHaveBeenCalledTimes(1);
  });

  it('Send anyway posts acknowledge_recent_reply true once and then matches a normal approve', async () => {
    api.proposal.mockResolvedValue(draft);
    let release;
    api.sendProposal.mockImplementation((id, body) => {
      if (body && body.acknowledge_recent_reply === true) {
        return new Promise((resolve) => { release = () => resolve({ id, status: 'sent' }); });
      }
      return Promise.reject(recentReplyError());
    });
    const { bump } = renderDrawer();
    await openConfirm();
    await userEvent.click(screen.getByRole('button', { name: 'Send it' }));
    const warning = await screen.findByRole('alert');
    const sendAnyway = within(warning).getByRole('button', { name: 'Send anyway' });
    sendAnyway.click();
    sendAnyway.click();
    await waitFor(() => expect(api.sendProposal).toHaveBeenCalledTimes(2));
    expect(api.sendProposal.mock.calls[0]).toEqual([9, undefined]);
    const ack = api.sendProposal.mock.calls[1][1];
    expect(ack).toEqual({ acknowledge_recent_reply: true });
    expect(ack.acknowledge_recent_reply).toBe(true);
    expect(typeof ack.acknowledge_recent_reply).toBe('boolean');
    expect(screen.getByRole('button', { name: 'Sending…' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Open that proposal' })).toBeDisabled();

    api.proposal.mockResolvedValue(sent);
    release();
    expect(await screen.findByText('Out')).toBeInTheDocument();
    expect(document.querySelector('.toast')).toHaveTextContent('Sent to test+owner@example.test.');
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Approve and send' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Send anyway' })).toBeNull();
    expect(bump).toHaveBeenCalled();
    expect(api.sendProposal).toHaveBeenCalledTimes(2);
  });

  it('sends confirm and acknowledge together when the held-back step came first', async () => {
    api.proposal.mockResolvedValue(draft);
    api.sendProposal
      .mockRejectedValueOnce(heldBackError())
      .mockRejectedValueOnce(recentReplyError())
      .mockResolvedValueOnce({ id: 9, status: 'sent' });
    renderDrawer();
    await openConfirm();
    await userEvent.click(screen.getByRole('button', { name: 'Send it' }));
    const dialog = await screen.findByRole('alertdialog', { name: 'Confirm send' });
    expect(dialog).toHaveTextContent('This draft is marked for another look. Send it only if you mean to.');
    expect(screen.queryByRole('alert')).toBeNull();
    expect(document.querySelector('.toast')).not.toHaveTextContent(HELD_BACK);
    expect(api.sendProposal).toHaveBeenCalledWith(9, undefined);

    await userEvent.click(within(dialog).getByRole('button', { name: 'Send it' }));
    const warning = await screen.findByRole('alert');
    expect(warning).toHaveTextContent(SENTENCE);
    expect(api.sendProposal.mock.calls[1][1]).toEqual({ confirm: true });

    api.proposal.mockResolvedValue(sent);
    await userEvent.click(within(warning).getByRole('button', { name: 'Send anyway' }));
    const ack = api.sendProposal.mock.calls[2][1];
    expect(ack).toEqual({ confirm: true, acknowledge_recent_reply: true });
    expect(ack.confirm).toBe(true);
    expect(ack.acknowledge_recent_reply).toBe(true);
    expect(await screen.findByText('Out')).toBeInTheDocument();
    expect(api.sendProposal).toHaveBeenCalledTimes(3);
  });

  it('sends both when recent_reply comes back before the held-back confirm', async () => {
    api.proposal.mockResolvedValue(draft);
    api.sendProposal
      .mockRejectedValueOnce(recentReplyError())
      .mockRejectedValueOnce(heldBackError())
      .mockResolvedValueOnce({ id: 9, status: 'sent' });
    renderDrawer();
    await openConfirm();
    await userEvent.click(screen.getByRole('button', { name: 'Send it' }));
    const warning = await screen.findByRole('alert');
    expect(api.sendProposal.mock.calls[0][1]).toBeUndefined();

    await userEvent.click(within(warning).getByRole('button', { name: 'Send anyway' }));
    expect(api.sendProposal.mock.calls[1][1]).toEqual({ acknowledge_recent_reply: true });
    expect(api.sendProposal.mock.calls[1][1].confirm).toBeUndefined();
    expect(warning).toHaveTextContent('This draft is marked for another look. Send it only if you mean to.');
    expect(document.querySelector('.toast')).not.toHaveTextContent(HELD_BACK);
    expect(screen.getByRole('alert')).toBe(warning);

    api.proposal.mockResolvedValue(sent);
    await userEvent.click(within(warning).getByRole('button', { name: 'Send anyway' }));
    const ack = api.sendProposal.mock.calls[2][1];
    expect(ack).toEqual({ confirm: true, acknowledge_recent_reply: true });
    expect(typeof ack.confirm).toBe('boolean');
    expect(typeof ack.acknowledge_recent_reply).toBe('boolean');
    expect(await screen.findByText('Out')).toBeInTheDocument();
    expect(api.sendProposal).toHaveBeenCalledTimes(3);
  });

  it('includes confirm on Send anyway when the original approve already carried it', async () => {
    api.proposal.mockResolvedValue({
      ...draft,
      stop_reason: 'Needs manual review: the send outcome is uncertain',
    });
    api.sendProposal
      .mockRejectedValueOnce(recentReplyError())
      .mockResolvedValueOnce({ id: 9, status: 'sent' });
    renderDrawer();
    await openConfirm();
    expect(screen.getByText('This draft is marked for another look. Send it only if you mean to.')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Send it' }));
    expect(api.sendProposal).toHaveBeenCalledWith(9, { confirm: true });
    const warning = await screen.findByRole('alert');
    api.proposal.mockResolvedValue(sent);
    await userEvent.click(within(warning).getByRole('button', { name: 'Send anyway' }));
    expect(api.sendProposal.mock.calls[1][1]).toEqual({ confirm: true, acknowledge_recent_reply: true });
    expect(await screen.findByText('Out')).toBeInTheDocument();
  });

  it('keeps the sibling draft on screen when Send anyway finishes after the drawer moves', async () => {
    const versions = [
      { id: 9, version: 2, status: 'draft' },
      { id: 42, version: 1, status: 'draft' },
    ];
    const original = { ...draft, versions };
    const sibling = {
      ...draft,
      id: 42,
      version: 1,
      company: 'TEST: Peak Plumbing',
      subject: 'Earlier draft',
      body: 'Sibling draft body.',
      status: 'draft',
      updated_at: '2026-11-18T16:00:00.000Z',
      versions,
    };
    let current = original;
    api.proposal.mockImplementation(async (pid) => (pid === 42 ? sibling : current));
    let release;
    api.sendProposal.mockImplementation((id, body) => {
      if (body && body.acknowledge_recent_reply === true) {
        return new Promise((resolve) => { release = () => resolve({ id, status: 'sent' }); });
      }
      return Promise.reject(recentReplyError());
    });
    const { rerenderDrawer } = renderDrawer();
    await openConfirm();
    await userEvent.click(screen.getByRole('button', { name: 'Send it' }));
    const warning = await screen.findByRole('alert');
    within(warning).getByRole('button', { name: 'Send anyway' }).click();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Sending…' })).toBeDisabled());
    expect(screen.getByRole('button', { name: 'Open that proposal' })).toBeDisabled();
    expect(screen.getByRole('combobox', { name: 'Version' })).toBeDisabled();

    rerenderDrawer({ id: 42 });
    expect(await screen.findByRole('heading', { name: 'TEST: Peak Plumbing' })).toBeInTheDocument();
    expect(screen.getByDisplayValue('Earlier draft')).toBeInTheDocument();
    expect(screen.getByDisplayValue('Sibling draft body.')).toBeInTheDocument();

    current = { ...original, status: 'sent', sent_at: '2026-11-20T16:00:00.000Z', updated_at: '2026-11-20T16:00:00.000Z' };
    await act(async () => { release(); });
    expect(api.sendProposal).toHaveBeenCalledTimes(2);
    expect(screen.getByRole('heading', { name: 'TEST: Peak Plumbing' })).toBeInTheDocument();
    expect(screen.getByDisplayValue('Earlier draft')).toBeInTheDocument();
    expect(screen.getByDisplayValue('Sibling draft body.')).toBeInTheDocument();
    expect(screen.getByRole('dialog', { name: 'Proposal for TEST: Peak Plumbing' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'TEST: Wasatch Heating' })).toBeNull();
    const ack = api.sendProposal.mock.calls[1];
    expect(ack[0]).toBe(9);
    expect(ack[1]).toEqual({ acknowledge_recent_reply: true });
    expect(ack[1].acknowledge_recent_reply).toBe(true);
    expect(typeof ack[1].acknowledge_recent_reply).toBe('boolean');
    expect(api.sendProposal.mock.calls[0]).toEqual([9, undefined]);
  });

  it('Cancel after recent_reply then held-back leaves no confirm dialog', async () => {
    api.proposal.mockResolvedValue(draft);
    api.sendProposal
      .mockRejectedValueOnce(recentReplyError())
      .mockRejectedValueOnce(heldBackError())
      .mockRejectedValueOnce(recentReplyError())
      .mockResolvedValueOnce({ id: 9, status: 'sent' });
    renderDrawer();
    await openConfirm();
    await userEvent.click(screen.getByRole('button', { name: 'Send it' }));
    const warning = await screen.findByRole('alert');
    await userEvent.click(within(warning).getByRole('button', { name: 'Send anyway' }));
    expect(await within(warning).findByText('This draft is marked for another look. Send it only if you mean to.')).toBeInTheDocument();
    expect(screen.queryByRole('alertdialog', { name: 'Confirm send' })).toBeNull();
    expect(api.sendProposal.mock.calls[1][1]).toEqual({ acknowledge_recent_reply: true });

    await userEvent.click(within(warning).getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.queryByRole('alertdialog', { name: 'Confirm send' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Send it' })).toBeNull();
    expect(api.sendProposal).toHaveBeenCalledTimes(2);

    await userEvent.click(screen.getByRole('button', { name: 'Approve and send' }));
    const dialog = screen.getByRole('alertdialog', { name: 'Confirm send' });
    expect(dialog).toHaveTextContent('This draft is marked for another look. Send it only if you mean to.');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Send it' }));
    expect(api.sendProposal.mock.calls[2][1]).toEqual({ confirm: true });
    const again = await screen.findByRole('alert');
    api.proposal.mockResolvedValue(sent);
    await userEvent.click(within(again).getByRole('button', { name: 'Send anyway' }));
    const ack = api.sendProposal.mock.calls[3][1];
    expect(ack).toEqual({ confirm: true, acknowledge_recent_reply: true });
    expect(ack.acknowledge_recent_reply).toBe(true);
    expect(typeof ack.acknowledge_recent_reply).toBe('boolean');
    expect(await screen.findByText('Out')).toBeInTheDocument();
  });

  it('disables Send anyway while a save is in flight', async () => {
    let releaseSave;
    api.proposal.mockResolvedValue(draft);
    api.updateProposal.mockImplementation(() => new Promise((resolve) => {
      releaseSave = () => resolve({ ...draft, subject: 'Updated subject' });
    }));
    api.sendProposal.mockRejectedValue(recentReplyError());
    renderDrawer();
    await openConfirm();
    await userEvent.click(screen.getByRole('button', { name: 'Send it' }));
    const warning = await screen.findByRole('alert');
    const sendAnyway = within(warning).getByRole('button', { name: 'Send anyway' });
    expect(sendAnyway).toBeEnabled();
    const subject = screen.getByLabelText('Subject');
    await userEvent.clear(subject);
    await userEvent.type(subject, 'Updated subject');
    await userEvent.tab();
    await waitFor(() => expect(sendAnyway).toBeDisabled());
    expect(api.sendProposal).toHaveBeenCalledTimes(1);
    expect(api.updateProposal).toHaveBeenCalledWith(9, { subject: 'Updated subject' });
    releaseSave();
    await waitFor(() => expect(within(screen.getByRole('alert')).getByRole('button', { name: 'Send anyway' })).toBeEnabled());
    expect(api.sendProposal).toHaveBeenCalledTimes(1);
  });

  it('Cancel dismisses the warning, sends nothing more, and leaves the draft', async () => {
    api.proposal.mockResolvedValue(draft);
    api.sendProposal.mockRejectedValue(recentReplyError());
    renderDrawer();
    await openConfirm();
    await userEvent.click(screen.getByRole('button', { name: 'Send it' }));
    const warning = await screen.findByRole('alert');
    await userEvent.click(within(warning).getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.queryByText(SENTENCE)).toBeNull();
    expect(screen.getByText('To review')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Approve and send' })).toBeEnabled();
    expect(api.sendProposal).toHaveBeenCalledTimes(1);
    expect(api.sendProposal).toHaveBeenCalledWith(9, undefined);
    expect(api.proposal).not.toHaveBeenCalledWith(42);
  });

  it('leaves other 409s and errors on the toast', async () => {
    api.proposal.mockResolvedValue(draft);
    api.sendProposal.mockRejectedValue(Object.assign(new Error(OTHER_409), { status: 409 }));
    const view = renderDrawer();
    await openConfirm();
    await userEvent.click(screen.getByRole('button', { name: 'Send it' }));
    await waitFor(() => expect(document.querySelector('.toast')).toHaveTextContent(OTHER_409));
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getByRole('alertdialog', { name: 'Confirm send' })).toBeInTheDocument();
    expect(screen.getByText('To review')).toBeInTheDocument();
    view.unmount();

    api.proposal.mockResolvedValue(draft);
    api.sendProposal.mockRejectedValue(Object.assign(new Error('Couldn\'t reach the API.'), { status: 0 }));
    renderDrawer();
    await openConfirm();
    await userEvent.click(screen.getByRole('button', { name: 'Send it' }));
    await waitFor(() => expect(document.querySelector('.toast')).toHaveTextContent('Couldn\'t reach the API.'));
    expect(screen.queryByRole('alert')).toBeNull();

    api.sendProposal.mockRejectedValue(recentReplyError({ sibling_proposal_id: '42' }));
    await userEvent.click(screen.getByRole('button', { name: 'Send it' }));
    await waitFor(() => expect(document.querySelector('.toast')).toHaveTextContent('recent_reply'));
    expect(screen.queryByRole('button', { name: 'Send anyway' })).toBeNull();
  });

  it('flag-off 200 path rendered output matches a normal approve', async () => {
    api.proposal.mockResolvedValue(draft);
    api.sendProposal.mockResolvedValue({ id: 9, status: 'sent' });
    renderDrawer();
    const confirm = await openConfirm();
    expect([...confirm.children].map((el) => el.className)).toEqual(['', 'muted', 'link-row']);
    expect(confirm).toHaveTextContent('Send to Sam <test+owner@example.test>?');
    expect(confirm).toHaveTextContent('“Missed after-hours calls” goes out now from your Gmail. Follow-ups are scheduled for day 3 and day 10 and stop automatically if they reply, book, bounce or opt out.');
    expect(within(confirm).getByRole('button', { name: 'Send it' })).toBeEnabled();
    expect(within(confirm).queryByRole('button', { name: 'Send anyway' })).toBeNull();
    expect(confirm.querySelector('.reply-warning')).toBeNull();

    api.proposal.mockResolvedValue(sent);
    await userEvent.click(within(confirm).getByRole('button', { name: 'Send it' }));
    const drawer = await screen.findByRole('dialog', { name: 'Proposal for TEST: Wasatch Heating' });
    expect(await within(drawer).findByText('Out')).toBeInTheDocument();
    expect(drawer.querySelector('.reply-warning')).toBeNull();
    expect(drawer).not.toHaveTextContent('Send anyway');
    expect(drawer).not.toHaveTextContent('Open that proposal');
    expect(drawer).not.toHaveTextContent('replied to another proposal');
    expect(within(drawer).queryByRole('button', { name: 'Approve and send' })).toBeNull();
    expect(within(drawer).getByRole('button', { name: 'They replied another way' })).toBeInTheDocument();
    expect(document.querySelector('.toast')).toHaveTextContent('Sent to test+owner@example.test.');
    expect(api.sendProposal).toHaveBeenCalledTimes(1);
    expect(api.sendProposal).toHaveBeenCalledWith(9, undefined);
  });

  it('keeps the proposals list on open-only and gives the warning 44px stacked actions', async () => {
    const openProposal = vi.fn();
    render(<Proposals version={1} bump={() => {}} openProposal={openProposal} />);
    await userEvent.click(await screen.findByRole('button', { name: /Wasatch Air Co/ }));
    expect(openProposal).toHaveBeenCalledWith(7);
    expect(api.sendProposal).not.toHaveBeenCalled();

    const css = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '../styles.css'), 'utf8');
    const block = css.slice(css.indexOf('.reply-warning {'), css.indexOf('.check {'));
    expect(block).toContain('min-height: 44px');
    expect(block).toContain('color: var(--ink)');
    expect(block).toContain('background: var(--ochre-wash)');
    expect(block).not.toContain('.reply-warning-link');
    expect(block).not.toMatch(/#[0-9A-Fa-f]{3,8}/);
    const buttons = css.slice(css.indexOf('.btn {'), css.indexOf('.btn-quiet'));
    expect(buttons).toContain('background: var(--juniper)');
    expect(buttons).toContain('color: var(--juniper-ink)');
    expect(css).toContain('.btn-quiet { background: transparent; color: var(--ink); border-color: var(--line); }');
    const phone = css.slice(css.indexOf('@media (max-width: 860px)'));
    expect(phone).toContain('.reply-warning-actions { flex-direction: column; }');
    expect(phone).toContain('.reply-warning-actions .btn { width: 100%; white-space: normal; text-align: center; }');
    expect(css).toContain('--ink-2: #55656B');
    expect(css).toContain('--paper: #F3F6F5');
  });
});
