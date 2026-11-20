import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useState } from 'react';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { CALL_LIST_KIND_FIELD, CALL_LIST_SET_AT_FIELD, CALL_OUTCOMES, api } from '../api';
import { foundLead, focus } from '../test/fixtures.js';
import { installApiDefaults } from '../test/defaults.js';
import {
  mockRecordCallOutcome,
  presentProspectKeys,
  resetCallListMock,
  seedCallListLead,
  setMockCallListEnabled,
  stageAfterOutcome,
} from '../test/call-list-rules.js';
import {
  CALL_REASONS,
  SCOUT_COPY,
  callListItem,
  enabledCallList,
  walkInItem,
} from '../test/call-list-fixtures.js';
import LeadDrawer from './LeadDrawer';
import Leads from './Leads';
import Pipeline from './Pipeline';
import Today from './Today';
import {
  CALL_OUTCOME_LABELS,
  EMPTY_CALL_LIST,
  UNDO_MS,
  applyMarkerResponse,
  backOnLabel,
  callListErrorMessage,
  callListIsOnlySurface,
  readCallListKind,
  safeMaps,
  safeTel,
} from './call-list';

const here = path.dirname(fileURLToPath(import.meta.url));
const css = readFileSync(path.join(here, '../styles.css'), 'utf8');
const panelSource = readFileSync(path.join(here, 'CallListPanel.jsx'), 'utf8');
const markerSource = readFileSync(path.join(here, 'CallListMarker.jsx'), 'utf8');

const callRow = callListItem();
const walkRow = walkInItem();

function Harness({ openLead = () => {} }) {
  const [version, setVersion] = useState(0);
  return (
    <>
      <button type="button" onClick={() => setVersion((value) => value + 1)}>Refresh day</button>
      <Today version={version} bump={() => setVersion((value) => value + 1)} openLead={openLead} openProject={() => {}} />
    </>
  );
}

function renderToday(openLead = () => {}) {
  return render(<Harness openLead={openLead} />);
}

function pageHtml(view) {
  return view.container.querySelector('.page').innerHTML;
}

async function settle() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

beforeEach(() => {
  installApiDefaults();
});

describe('call list flag off', () => {
  it('renders Today the same for enabled false and a 404, with no new copy', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-20T18:00:00.000Z'));
    try {
      api.todayCallList.mockResolvedValue({ enabled: false, items: [] });
      const off = renderToday();
      expect(await screen.findByRole('heading', { name: 'Call next' })).toBeInTheDocument();
      await waitFor(() => expect(api.todayCallList).toHaveBeenCalled());
      const offHtml = pageHtml(off);
      off.unmount();

      api.todayCallList.mockRejectedValue(Object.assign(new Error('not_found'), { status: 404 }));
      const missing = renderToday();
      expect(await screen.findByRole('heading', { name: 'Call next' })).toBeInTheDocument();
      await waitFor(() => expect(api.todayCallList).toHaveBeenCalledTimes(2));
      expect(pageHtml(missing)).toBe(offHtml);
      expect(offHtml).toContain('Call next');
      expect(offHtml).toContain('Follow-ups due');
      expect(offHtml).not.toContain('Calls due');
      expect(offHtml).not.toContain('Add to call list');
      expect(foundLead).not.toHaveProperty('call_list_kind');
      expect(foundLead).not.toHaveProperty('call_list_set_at');
      expect(focus.followups_due[0]).not.toHaveProperty('call_list_kind');
      expect(focus.top_new_leads[0]).not.toHaveProperty('call_list_set_at');
      expect(focus.gone_quiet).toEqual([]);
      expect(screen.queryByRole('heading', { name: 'Calls due / Walk-ins' })).not.toBeInTheDocument();
      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it('hides the panel when the first request fails before the flag is known, including 401 and 500', async () => {
    api.todayCallList.mockRejectedValue(Object.assign(new Error('Missing or invalid API key'), { status: 401 }));
    const denied = renderToday();
    expect(await screen.findByRole('heading', { name: 'Call next' })).toBeInTheDocument();
    await waitFor(() => expect(api.todayCallList).toHaveBeenCalled());
    expect(screen.queryByRole('heading', { name: 'Calls due / Walk-ins' })).not.toBeInTheDocument();
    expect(screen.queryByText('Missing or invalid API key')).not.toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    denied.unmount();

    api.todayCallList.mockRejectedValue(Object.assign(new Error('Something went wrong.'), { status: 500 }));
    renderToday();
    expect(await screen.findByRole('heading', { name: 'Follow-ups due' })).toBeInTheDocument();
    await waitFor(() => expect(api.todayCallList).toHaveBeenCalled());
    expect(screen.queryByRole('heading', { name: 'Calls due / Walk-ins' })).not.toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Call next' })).toBeInTheDocument();
  });

  it('shows a retry when a later request fails after the flag was on', async () => {
    api.todayCallList.mockResolvedValue(enabledCallList([callRow]));
    renderToday();
    expect(await screen.findByRole('heading', { name: 'Calls due / Walk-ins' })).toBeInTheDocument();
    api.todayCallList.mockRejectedValue(Object.assign(new Error('Something went wrong.'), { status: 500 }));
    fireEvent.click(screen.getByRole('button', { name: 'Refresh day' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Something went wrong.');
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Call next' })).not.toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Follow-ups due' })).toBeInTheDocument();
    api.todayCallList.mockResolvedValue(enabledCallList([callRow]));
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText(CALL_REASONS.demo_view)).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('keeps Call next and the task panel when the call list is off and a task is open', async () => {
    api.todayCallList.mockResolvedValue({ enabled: false, items: [] });
    api.demoViewTasks.mockResolvedValue({
      tasks: [{
        id: 1,
        prospect_id: 41,
        company: 'TEST: Wasatch Heating',
        view_count: 1,
        last_viewed_at: '2026-11-20T18:00:00.000Z',
        source: 'onepager',
        trade: 'HVAC',
        city: 'Saratoga Springs',
        phone: '(801) 555-0142',
      }],
    });
    renderToday();
    expect(await screen.findByRole('heading', { name: 'Call them' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Call next' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Calls due / Walk-ins' })).not.toBeInTheDocument();
  });
});

describe('call list rows', () => {
  beforeEach(() => {
    api.todayCallList.mockResolvedValue(enabledCallList([callRow, walkRow]));
  });

  it('renders a call row and a walk-in row with tel and map links', async () => {
    const openLead = vi.fn();
    renderToday(openLead);
    const region = await screen.findByRole('region', { name: 'Calls due / Walk-ins' });
    expect(within(region).getByText('Taps open your phone or Maps. Nothing is sent from here.')).toBeInTheDocument();
    expect(within(region).getByText(CALL_REASONS.demo_view)).toBeInTheDocument();
    const script = within(region).getByRole('button', { name: SCOUT_COPY.callEmailed });
    expect(script).toHaveAttribute('aria-expanded', 'false');
    expect(script.className).not.toContain('is-open');
    fireEvent.click(script);
    expect(script).toHaveAttribute('aria-expanded', 'true');
    expect(script.className).toContain('is-open');
    expect(within(region).getByText('Call', { selector: '.call-list-badge' })).toBeInTheDocument();
    expect(within(region).getByText('Walk-in', { selector: '.call-list-badge' })).toBeInTheDocument();
    expect(within(region).queryByRole('button', { name: 'No answer' })).not.toBeInTheDocument();
    const tel = within(region).getByRole('link', { name: 'Call TEST: Wasatch Heating' });
    expect(tel).toHaveAttribute('href', 'tel:8015550142');
    expect(tel).toHaveClass('is-primary');
    expect(tel).not.toHaveAttribute('target');
    const maps = within(region).getAllByRole('link', { name: /Map for / });
    expect(maps[0]).toHaveAttribute('href', callRow.maps_url);
    expect(maps[0]).toHaveAttribute('target', '_blank');
    expect(maps[0]).toHaveAttribute('rel', 'noreferrer');
    expect(maps[0]).toHaveClass('is-secondary');
    expect(maps[1]).toHaveAttribute('href', walkRow.maps_url);
    expect(maps[1]).toHaveClass('is-primary');
    expect(within(region).queryByRole('link', { name: 'Call TEST: Eagle Mountain Plumbing' })).not.toBeInTheDocument();
    expect(within(region).getByText(SCOUT_COPY.walkIn)).toBeInTheDocument();
    expect(within(region).getByText(CALL_REASONS.listedWalkIn)).toBeInTheDocument();
    expect(within(region).queryByText('Voicemail and the ask')).not.toBeInTheDocument();
    fireEvent.click(within(region).getByRole('button', { name: 'Log TEST: Wasatch Heating' }));
    const callDetails = within(region).getByText('Voicemail and the ask').closest('details');
    expect(callDetails).not.toHaveAttribute('open');
    expect(within(callDetails).getByText(SCOUT_COPY.voicemail)).toBeInTheDocument();
    expect(within(callDetails).getByText(SCOUT_COPY.ask)).toBeInTheDocument();
    expect(within(region).getByRole('button', { name: 'No answer' })).toBeInTheDocument();
    fireEvent.click(within(region).getByRole('button', { name: 'Log TEST: Eagle Mountain Plumbing' }));
    expect(within(region).queryByText('Voicemail and the ask')).not.toBeInTheDocument();
    const walkDetails = within(region).getByText('The ask').closest('details');
    expect(within(walkDetails).queryByText(SCOUT_COPY.voicemail)).not.toBeInTheDocument();
    expect(walkDetails.querySelectorAll('p')).toHaveLength(1);
    expect(within(walkDetails).getByText(SCOUT_COPY.ask)).toBeInTheDocument();
    expect(within(region).getAllByRole('button', { name: 'No answer' })).toHaveLength(1);
    expect(walkRow.voicemail_script).toBeNull();
    expect(walkRow.emailed).toBe(false);
    expect(walkRow.open_task_id).toBeNull();
    expect(callRow.emailed).toBe(true);
    expect(callRow.open_task_id).toBe(7);
    fireEvent.click(within(region).getByRole('button', { name: 'TEST: Wasatch Heating' }));
    expect(openLead).toHaveBeenCalledWith(41);
    expect(screen.queryByRole('heading', { name: 'Call next' })).not.toBeInTheDocument();
  });

  it('omits the ask line when the row has no ask', async () => {
    api.todayCallList.mockResolvedValue(enabledCallList([{ ...callRow, ask: '  ' }]));
    renderToday();
    const region = await screen.findByRole('region', { name: 'Calls due / Walk-ins' });
    fireEvent.click(within(region).getByRole('button', { name: 'Log TEST: Wasatch Heating' }));
    const details = within(region).getByText('Voicemail', { selector: 'summary' }).closest('details');
    expect(within(details).getByText(SCOUT_COPY.voicemail)).toBeInTheDocument();
    expect(within(details).queryByText(SCOUT_COPY.ask)).not.toBeInTheDocument();
    expect(panelSource).not.toContain('Free, 15 minutes');
    expect(markerSource).not.toContain('call_list_kind');
  });

  it('loads the rest with GET ?all=1 when Show N more is tapped', async () => {
    const third = callListItem({
      prospect_id: 43,
      company: 'TEST: Lehi Electric',
      reason: CALL_REASONS.sequence_done,
      reason_code: 'sequence_done',
      emailed: false,
      script: SCOUT_COPY.callNeverEmailed,
      open_task_id: null,
    });
    api.todayCallList.mockReset();
    api.todayCallList
      .mockResolvedValueOnce(enabledCallList([callRow], { cap: 8, more: 2 }))
      .mockResolvedValueOnce(enabledCallList([callRow, walkRow, third], { cap: 8, more: 0 }));
    renderToday();
    const region = await screen.findByRole('region', { name: 'Calls due / Walk-ins' });
    expect(within(region).getByText('TEST: Wasatch Heating')).toBeInTheDocument();
    expect(within(region).queryByText('TEST: Eagle Mountain Plumbing')).not.toBeInTheDocument();
    expect(api.todayCallList.mock.calls[0]).toEqual([]);
    fireEvent.click(within(region).getByRole('button', { name: 'Show 2 more' }));
    expect(await within(region).findByText('TEST: Eagle Mountain Plumbing')).toBeInTheDocument();
    expect(within(region).getByText('TEST: Lehi Electric')).toBeInTheDocument();
    expect(within(region).getByText(SCOUT_COPY.callNeverEmailed)).toBeInTheDocument();
    expect(api.todayCallList.mock.calls[1]).toEqual([{ all: true }]);
    expect(within(region).queryByRole('button', { name: 'Show 2 more' })).not.toBeInTheDocument();
  });

  it('prints the server reason as-is, including a tier 1 view after an outcome', async () => {
    const tier1 = callListItem({
      last_outcome: 'talked',
      last_outcome_at: '2026-11-19T18:00:00.000Z',
      reason: CALL_REASONS.demo_view,
    });
    const listed = callListItem({
      prospect_id: 45,
      company: 'TEST: Lehi Electric',
      reason: CALL_REASONS.listedCall,
      reason_code: 'listed',
      emailed: false,
      script: SCOUT_COPY.callNeverEmailed,
      open_task_id: null,
    });
    const missed = callListItem({
      prospect_id: 46,
      company: 'TEST: American Fork Air',
      reason: CALL_REASONS.no_answer,
      reason_code: 'sequence_done',
      last_outcome: 'no_answer',
      last_outcome_at: '2026-11-17T18:00:00.000Z',
    });
    const stopped = walkInItem({
      reason: CALL_REASONS.stoppedBy,
      last_outcome: 'voicemail',
    });
    const talked = callListItem({
      prospect_id: 47,
      company: 'TEST: Peak Plumbing',
      reason: CALL_REASONS.talked,
      reason_code: 'intro_3_5d',
      last_outcome: 'talked',
      script: SCOUT_COPY.callNeverEmailed,
      open_task_id: null,
    });
    api.todayCallList.mockResolvedValue(enabledCallList([tier1, listed, missed, stopped, talked]));
    renderToday();
    const region = await screen.findByRole('region', { name: 'Calls due / Walk-ins' });
    expect(within(region).getByText(CALL_REASONS.demo_view)).toBeInTheDocument();
    expect(within(region).getByText(CALL_REASONS.listedCall)).toBeInTheDocument();
    expect(within(region).getByText(CALL_REASONS.no_answer)).toBeInTheDocument();
    expect(within(region).getByText(CALL_REASONS.stoppedBy)).toBeInTheDocument();
    expect(within(region).getByText(CALL_REASONS.talked)).toBeInTheDocument();
    expect(within(region).queryByText(CALL_REASONS.voicemail)).not.toBeInTheDocument();
    expect(panelSource).not.toContain('Viewed the demo');
    expect(panelSource).not.toContain('try again');
  });

  it('uses the empty sentence when the list is on and has no rows', async () => {
    api.todayCallList.mockResolvedValue(enabledCallList([]));
    renderToday();
    expect(await screen.findByText(EMPTY_CALL_LIST)).toBeInTheDocument();
    expect(screen.getByText('No calls due today. Add leads from a lead\'s drawer.')).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Call next' })).not.toBeInTheDocument();
  });
});

describe('call list outcomes', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    api.todayCallList.mockResolvedValue(enabledCallList([callRow, walkRow]));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  async function ready() {
    renderToday();
    await settle();
    return screen.getByRole('region', { name: 'Calls due / Walk-ins' });
  }

  it('waits 8 seconds, Undo sends nothing, and the timeout sends one POST', async () => {
    api.recordCallOutcome.mockResolvedValue({ activity_id: 3, removed: false, back_on: null });
    const region = await ready();
    fireEvent.click(within(region).getByRole('button', { name: 'Log TEST: Wasatch Heating' }));
    fireEvent.click(within(region).getByRole('button', { name: 'No answer' }));
    expect(within(region).getByRole('status')).toHaveTextContent('No answer. Undo to cancel.');
    expect(within(region).getByRole('status')).not.toHaveTextContent('(8)');
    expect(within(region).getByRole('button', { name: 'Undo No answer (8)' })).toBeInTheDocument();
    await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
    expect(within(region).getByRole('button', { name: 'Undo No answer (7)' })).toBeInTheDocument();
    await act(async () => { await vi.advanceTimersByTimeAsync(6000); });
    expect(within(region).getByRole('button', { name: 'Undo No answer (1)' })).toBeInTheDocument();
    expect(api.recordCallOutcome).not.toHaveBeenCalled();
    fireEvent.click(within(region).getByRole('button', { name: 'Undo No answer (1)' }));
    await act(async () => { await vi.advanceTimersByTimeAsync(UNDO_MS); });
    expect(api.recordCallOutcome).not.toHaveBeenCalled();
    expect(within(region).getByRole('button', { name: 'No answer' })).toBeInTheDocument();

    fireEvent.click(within(region).getByRole('button', { name: 'No answer' }));
    await act(async () => { await vi.advanceTimersByTimeAsync(UNDO_MS); });
    expect(api.recordCallOutcome).toHaveBeenCalledTimes(1);
    expect(api.recordCallOutcome).toHaveBeenCalledWith('41', { outcome: 'no_answer', kind: 'call' });
  });

  it('sends each outcome once, with the row kind, after 8 seconds', async () => {
    api.recordCallOutcome.mockResolvedValue({ activity_id: 4, removed: false, back_on: null });
    const region = await ready();
    fireEvent.click(within(region).getByRole('button', { name: 'Log TEST: Wasatch Heating' }));
    for (const outcome of CALL_OUTCOMES) {
      fireEvent.click(within(region).getByRole('button', { name: CALL_OUTCOME_LABELS[outcome] }));
      await act(async () => { await vi.advanceTimersByTimeAsync(UNDO_MS); });
    }
    expect(api.recordCallOutcome).toHaveBeenCalledTimes(CALL_OUTCOMES.length);
    CALL_OUTCOMES.forEach((outcome, index) => {
      expect(api.recordCallOutcome).toHaveBeenNthCalledWith(index + 1, '41', { outcome, kind: 'call' });
    });
    api.recordCallOutcome.mockClear();
    fireEvent.click(within(region).getByRole('button', { name: 'Log TEST: Eagle Mountain Plumbing' }));
    fireEvent.click(within(region).getByRole('button', { name: 'Voicemail' }));
    await act(async () => { await vi.advanceTimersByTimeAsync(UNDO_MS); });
    expect(api.recordCallOutcome).toHaveBeenCalledTimes(1);
    expect(api.recordCallOutcome).toHaveBeenCalledWith('42', { outcome: 'voicemail', kind: 'walk_in' });
  });

  it('ignores a second tap and still sends one POST', async () => {
    api.recordCallOutcome.mockResolvedValue({ activity_id: 5, removed: false, back_on: null });
    const region = await ready();
    fireEvent.click(within(region).getByRole('button', { name: 'Log TEST: Wasatch Heating' }));
    const button = within(region).getByRole('button', { name: 'Talked' });
    fireEvent.click(button);
    fireEvent.click(button);
    await act(async () => { await vi.advanceTimersByTimeAsync(UNDO_MS); });
    expect(api.recordCallOutcome).toHaveBeenCalledTimes(1);
    expect(api.recordCallOutcome).toHaveBeenCalledWith('41', { outcome: 'talked', kind: 'call' });
  });

  it('sends the pending outcome on unmount, page hide, and when the page is hidden', async () => {
    api.recordCallOutcome.mockResolvedValue({ activity_id: 6, removed: true, back_on: null });
    const first = renderToday();
    await settle();
    fireEvent.click(screen.getByRole('button', { name: 'Log TEST: Wasatch Heating' }));
    fireEvent.click(screen.getByRole('button', { name: 'Audit booked' }));
    first.unmount();
    expect(api.recordCallOutcome).toHaveBeenCalledTimes(1);
    expect(api.recordCallOutcome).toHaveBeenCalledWith('41', { outcome: 'audit_booked', kind: 'call' });

    api.recordCallOutcome.mockClear();
    const second = renderToday();
    await settle();
    fireEvent.click(screen.getByRole('button', { name: 'Log TEST: Wasatch Heating' }));
    fireEvent.click(screen.getByRole('button', { name: 'Not interested' }));
    await act(async () => { window.dispatchEvent(new Event('pagehide')); });
    expect(api.recordCallOutcome).toHaveBeenCalledTimes(1);
    expect(api.recordCallOutcome).toHaveBeenCalledWith('41', { outcome: 'not_interested', kind: 'call' });
    await act(async () => { await vi.advanceTimersByTimeAsync(UNDO_MS); });
    expect(api.recordCallOutcome).toHaveBeenCalledTimes(1);
    second.unmount();
    expect(api.recordCallOutcome).toHaveBeenCalledTimes(1);

    api.recordCallOutcome.mockClear();
    const third = renderToday();
    await settle();
    fireEvent.click(screen.getByRole('button', { name: 'Log TEST: Wasatch Heating' }));
    fireEvent.click(screen.getByRole('button', { name: 'Do not contact' }));
    const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
    await act(async () => { document.dispatchEvent(new Event('visibilitychange')); });
    expect(api.recordCallOutcome).toHaveBeenCalledTimes(1);
    expect(api.recordCallOutcome).toHaveBeenCalledWith('41', { outcome: 'do_not_contact', kind: 'call' });
    await act(async () => { window.dispatchEvent(new Event('pagehide')); });
    expect(api.recordCallOutcome).toHaveBeenCalledTimes(1);
    visibility.mockRestore();
    third.unmount();
  });

  it('restores the row and shows an error when the POST fails', async () => {
    api.recordCallOutcome.mockRejectedValue(Object.assign(new Error('Something went wrong.'), { status: 500 }));
    const region = await ready();
    fireEvent.click(within(region).getByRole('button', { name: 'Log TEST: Wasatch Heating' }));
    fireEvent.click(within(region).getByRole('button', { name: 'No answer' }));
    await act(async () => { await vi.advanceTimersByTimeAsync(UNDO_MS); });
    await settle();
    expect(api.recordCallOutcome).toHaveBeenCalledTimes(1);
    expect(within(region).getByRole('alert')).toHaveTextContent('Something went wrong.');
    expect(within(region).getByText('TEST: Wasatch Heating')).toBeInTheDocument();
    expect(within(region).getByRole('button', { name: 'No answer' })).toBeInTheDocument();
  });

  it('drops a removed row and shows when a lead comes back', async () => {
    vi.setSystemTime(new Date('2026-11-20T18:00:00.000Z'));
    api.recordCallOutcome.mockResolvedValue({ activity_id: 8, removed: true, back_on: null });
    const region = await ready();
    fireEvent.click(within(region).getByRole('button', { name: 'Log TEST: Wasatch Heating' }));
    fireEvent.click(within(region).getByRole('button', { name: 'Talked' }));
    await act(async () => { await vi.advanceTimersByTimeAsync(UNDO_MS); });
    await settle();
    expect(within(region).queryByText('TEST: Wasatch Heating')).not.toBeInTheDocument();
    expect(within(region).getByText('TEST: Eagle Mountain Plumbing')).toBeInTheDocument();

    api.recordCallOutcome.mockResolvedValue({ activity_id: 9, removed: true, back_on: '2026-11-23' });
    fireEvent.click(within(region).getByRole('button', { name: 'Log TEST: Eagle Mountain Plumbing' }));
    fireEvent.click(within(region).getByRole('button', { name: 'Voicemail' }));
    await act(async () => { await vi.advanceTimersByTimeAsync(UNDO_MS); });
    await settle();
    expect(within(region).getByText('Back on Mon')).toBeInTheDocument();
    expect(within(region).queryByRole('button', { name: 'Voicemail' })).not.toBeInTheDocument();

    api.recordCallOutcome.mockResolvedValue({ activity_id: 10, removed: false, back_on: '2026-11-24', stage: 'contacted' });
    const staying = callListItem({ prospect_id: 44, company: 'TEST: American Fork Air' });
    api.todayCallList.mockResolvedValue(enabledCallList([staying]));
    const again = renderToday();
    await settle();
    const next = again.container.querySelector('.call-list-panel');
    fireEvent.click(within(next).getByRole('button', { name: 'Log TEST: American Fork Air' }));
    fireEvent.click(within(next).getByRole('button', { name: 'No answer' }));
    await act(async () => { await vi.advanceTimersByTimeAsync(UNDO_MS); });
    await settle();
    expect(within(next).getByText('Back on Tue')).toBeInTheDocument();
    expect(within(next).getByRole('button', { name: 'No answer' })).toBeInTheDocument();
    expect(within(next).getByText('TEST: American Fork Air')).toBeInTheDocument();
  });
});

describe('call list on Today replaces the other call surfaces', () => {
  it('shows one tier-1 row and hides Call next and the task panel', async () => {
    api.focus.mockResolvedValue({
      ...focus,
      top_new_leads: [{ ...foundLead, id: 41, company: 'TEST: Wasatch Heating' }],
    });
    api.demoViewTasks.mockResolvedValue({
      tasks: [{
        id: 7,
        prospect_id: 41,
        company: 'TEST: Wasatch Heating',
        view_count: 2,
        last_viewed_at: '2026-11-19T20:00:00.000Z',
        source: 'demo',
        trade: 'HVAC',
        city: 'Saratoga Springs',
        phone: '(801) 555-0142',
      }],
    });
    api.todayCallList.mockResolvedValue(enabledCallList([callRow]));
    renderToday();
    const region = await screen.findByRole('region', { name: 'Calls due / Walk-ins' });
    expect(within(region).getByText(CALL_REASONS.demo_view)).toBeInTheDocument();
    expect(within(region).getByText('Call', { selector: '.call-list-badge' })).toBeInTheDocument();
    expect(within(region).getAllByText('TEST: Wasatch Heating')).toHaveLength(1);
    await waitFor(() => {
      expect(screen.queryByRole('heading', { name: 'Call next' })).not.toBeInTheDocument();
      expect(screen.queryByRole('heading', { name: 'Call them' })).not.toBeInTheDocument();
    });
    expect(screen.getByRole('heading', { name: 'Follow-ups due' })).toBeInTheDocument();
    expect(callListIsOnlySurface(true)).toBe(true);

    const scroll = vi.fn();
    HTMLElement.prototype.scrollIntoView = scroll;
    fireEvent.click(within(region).getByRole('link', { name: 'Call TEST: Wasatch Heating' }));
    expect(within(region).getByRole('button', { name: 'Do not contact' })).toBeInTheDocument();
    document.dispatchEvent(new Event('visibilitychange'));
    window.dispatchEvent(new Event('focus'));
    expect(scroll).toHaveBeenCalled();
    expect(callListIsOnlySurface(false)).toBe(false);
  });
});

describe('lead drawer call list control', () => {
  beforeEach(() => {
    setMockCallListEnabled(true);
  });

  function renderDrawer(lead) {
    api.prospect.mockResolvedValue(lead);
    return render(
      <LeadDrawer id={lead.id} onClose={() => {}} bump={() => {}} openProject={() => {}} openProposal={() => {}} />,
    );
  }

  it('stays off the drawer when the list is off or missing, even if the marker is set', async () => {
    api.todayCallList.mockResolvedValue({ enabled: false, items: [] });
    const off = renderDrawer({ ...foundLead, [CALL_LIST_KIND_FIELD]: 'call' });
    expect(await screen.findByRole('heading', { name: 'Wasatch Air Co' })).toBeInTheDocument();
    await waitFor(() => expect(api.todayCallList).toHaveBeenCalled());
    const offHtml = off.container.querySelector('[role="dialog"]').innerHTML;
    expect(screen.queryByRole('heading', { name: 'Add to call list' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Keep off call list' })).not.toBeInTheDocument();
    off.unmount();

    api.todayCallList.mockRejectedValue(Object.assign(new Error('not_found'), { status: 404 }));
    const missing = renderDrawer({ ...foundLead });
    expect(await screen.findByRole('heading', { name: 'Wasatch Air Co' })).toBeInTheDocument();
    await waitFor(() => expect(api.todayCallList).toHaveBeenCalledTimes(2));
    expect(missing.container.querySelector('[role="dialog"]').innerHTML).toBe(offHtml);
    expect(screen.queryByText('Add to call list')).not.toBeInTheDocument();
  });

  it('adds a call or a walk-in, keeps a lead off, and shows the excluded state', async () => {
    api.todayCallList.mockResolvedValue(enabledCallList([]));
    renderDrawer({ ...foundLead, company: 'TEST: Wasatch Heating', [CALL_LIST_KIND_FIELD]: null });
    expect(await screen.findByRole('heading', { name: 'Add to call list' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Keep off call list' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Call', pressed: false }));
    expect(await screen.findByRole('status')).toHaveTextContent('Added to the call list.');
    expect(api.saveCallListKind).toHaveBeenCalledWith(11, 'call');
    expect(screen.getByRole('button', { name: 'Call', pressed: true })).toBeInTheDocument();
    expect(screen.getByText('On the call list.')).toBeInTheDocument();
    expect(screen.getByText("Won't come back unless they view the demo")).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Walk-in' }));
    expect(await screen.findByText('Added to the walk-in list.')).toBeInTheDocument();
    expect(api.saveCallListKind).toHaveBeenCalledWith(11, 'walk_in');
    expect(screen.getByText('On the walk-in list.')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Keep off call list' }));
    expect(await screen.findByText('Kept off the call list.')).toBeInTheDocument();
    expect(api.removeCallList).toHaveBeenCalledWith(11);
    expect(screen.getByText('Kept off call list')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Call', pressed: false })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Walk-in', pressed: false })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Keep off call list' })).not.toBeInTheDocument();
  });

  it('shows a 409 from the mock when the lead is do-not-contact or archived', async () => {
    api.todayCallList.mockResolvedValue(enabledCallList([]));
    seedCallListLead({ id: foundLead.id, stage: 'found', do_not_contact: true });
    const blocked = renderDrawer({ ...foundLead, company: 'TEST: Wasatch Heating', call_list_kind: null });
    expect(await screen.findByRole('heading', { name: 'Add to call list' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Call', pressed: false }));
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('This lead is on do-not-contact'));
    expect(screen.queryByText('On the call list.')).not.toBeInTheDocument();
    blocked.unmount();

    seedCallListLead({ id: foundLead.id, stage: 'found', archived_at: '2026-11-01T00:00:00.000Z' });
    renderDrawer({ ...foundLead, company: 'TEST: Wasatch Heating', call_list_kind: null });
    expect(await screen.findByRole('heading', { name: 'Add to call list' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Walk-in', pressed: false }));
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('This lead is archived'));
    expect(screen.queryByText('On the walk-in list.')).not.toBeInTheDocument();
  });

  it('stays quiet when the marker keys are absent', async () => {
    api.todayCallList.mockResolvedValue(enabledCallList([]));
    const bare = { ...foundLead, company: 'TEST: Wasatch Heating' };
    renderDrawer(bare);
    expect(await screen.findByRole('heading', { name: 'TEST: Wasatch Heating' })).toBeInTheDocument();
    await waitFor(() => expect(api.todayCallList).toHaveBeenCalled());
    expect(screen.queryByRole('heading', { name: 'Add to call list' })).not.toBeInTheDocument();
    expect(bare).not.toHaveProperty('call_list_kind');
  });

  it('shows the contract errors inline and reads the marker response', async () => {
    api.todayCallList.mockResolvedValue(enabledCallList([]));
    api.saveCallListKind.mockResolvedValue({
      call_list_kind: 'call',
      call_list_set_at: '2026-11-20T18:00:00.000Z',
    });
    renderDrawer({
      ...foundLead,
      company: 'TEST: Wasatch Heating',
      call_list_kind: null,
      call_list_set_at: null,
    });
    expect(await screen.findByRole('heading', { name: 'Add to call list' })).toBeInTheDocument();
    const cases = [
      [() => api.saveCallListKind.mockRejectedValueOnce(Object.assign(new Error('do_not_contact'), { status: 409 })), 'Call', 'This lead is on do-not-contact'],
      [() => api.saveCallListKind.mockRejectedValueOnce(Object.assign(new Error('archived'), { status: 409 })), 'Call', 'This lead is archived'],
      [() => api.saveCallListKind.mockRejectedValueOnce(Object.assign(new Error('invalid_kind'), { status: 400 })), 'Walk-in', 'Pick a call or a walk-in.'],
    ];
    for (const [setup, name, text] of cases) {
      setup();
      fireEvent.click(screen.getByRole('button', { name }));
      await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(text));
    }
    api.saveCallListKind.mockResolvedValue({
      call_list_kind: 'call',
      call_list_set_at: '2026-11-20T18:04:00.000Z',
    });
    fireEvent.click(screen.getByRole('button', { name: 'Call' }));
    expect(await screen.findByText('On the call list.')).toBeInTheDocument();
    api.removeCallList.mockRejectedValueOnce(Object.assign(new Error('not_found'), { status: 404 }));
    fireEvent.click(screen.getByRole('button', { name: 'Keep off call list' }));
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Call list isn\'t available.'));
    expect(screen.getByText('On the call list.')).toBeInTheDocument();
  });

  it('shows add options for an excluded lead and reports a failed save', async () => {
    api.todayCallList.mockResolvedValue(enabledCallList([]));
    renderDrawer({ ...foundLead, company: 'TEST: Wasatch Heating', [CALL_LIST_KIND_FIELD]: 'excluded' });
    expect(await screen.findByText('Kept off call list')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Add to call list' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Keep off call list' })).not.toBeInTheDocument();
    api.saveCallListKind.mockRejectedValue(Object.assign(new Error('Something went wrong.'), { status: 500 }));
    fireEvent.click(screen.getByRole('button', { name: 'Walk-in' }));
    fireEvent.click(screen.getByRole('button', { name: 'Walk-in' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Something went wrong.');
    expect(api.saveCallListKind).toHaveBeenCalledTimes(1);
    expect(screen.getByText('Kept off call list')).toBeInTheDocument();
  });
});

describe('call outcome stage from the POST body', () => {
  const OPEN = ['found', 'contacted', 'responded', 'qualified', 'proposal'];

  afterEach(() => {
    vi.useRealTimers();
  });

  it('moves talked, audit booked, and not interested, and leaves the others', () => {
    expect(stageAfterOutcome('found', 'talked')).toBe('responded');
    expect(stageAfterOutcome('contacted', 'talked')).toBe('responded');
    expect(stageAfterOutcome('responded', 'talked')).toBe('responded');
    expect(stageAfterOutcome('qualified', 'talked')).toBe('qualified');
    expect(stageAfterOutcome('proposal', 'talked')).toBe('proposal');
    expect(stageAfterOutcome('found', 'audit_booked')).toBe('qualified');
    expect(stageAfterOutcome('contacted', 'audit_booked')).toBe('qualified');
    expect(stageAfterOutcome('responded', 'audit_booked')).toBe('qualified');
    expect(stageAfterOutcome('qualified', 'audit_booked')).toBe('qualified');
    expect(stageAfterOutcome('proposal', 'audit_booked')).toBe('proposal');
    for (const stage of OPEN) expect(stageAfterOutcome(stage, 'not_interested')).toBe('lost');
    for (const stage of ['won', 'lost', 'disqualified']) {
      expect(stageAfterOutcome(stage, 'not_interested')).toBe(stage);
    }
    for (const outcome of ['no_answer', 'voicemail', 'do_not_contact']) {
      for (const stage of [...OPEN, 'won', 'lost', 'disqualified']) {
        expect(stageAfterOutcome(stage, outcome)).toBe(stage);
      }
    }
    expect(panelSource).not.toContain('responded');
    expect(panelSource).not.toContain('qualified');
  });

  it('writes the returned stage onto the drawer, the pipeline, and the leads list', async () => {
    setMockCallListEnabled(true);
    const lead = {
      ...foundLead,
      id: 41,
      company: 'TEST: Wasatch Heating',
      stage: 'found',
      contact_name: '',
    };
    seedCallListLead(lead);
    api.recordCallOutcome.mockImplementation(async (id, body) => ({
      ...mockRecordCallOutcome(id, body, 'found'),
      removed: false,
    }));
    api.prospect.mockResolvedValue({ ...lead, activities: [], projects: [] });
    api.prospects.mockImplementation(async (filters = {}) => {
      const stage = String(filters.stage || '');
      if (stage === 'found' || stage === 'open' || stage === '') return { total: 1, prospects: [lead] };
      return { total: 0, prospects: [] };
    });
    api.todayCallList.mockResolvedValue(enabledCallList([callListItem({ prospect_id: 41 })]));
    render(
      <>
        <Today version={0} bump={() => {}} openLead={() => {}} openProject={() => {}} />
        <LeadDrawer id={41} onClose={() => {}} bump={() => {}} openProject={() => {}} openProposal={() => {}} />
        <Leads version={0} bump={() => {}} openLead={() => {}} />
        <Pipeline version={0} bump={() => {}} openLead={() => {}} openProject={() => {}} />
      </>,
    );
    const region = await screen.findByRole('region', { name: 'Calls due / Walk-ins' });
    const stage = () => within(screen.getByRole('dialog')).getByRole('combobox', { name: 'Stage' });
    const column = (name) => screen.getByRole('region', { name });
    const chip = () => within(screen.getByRole('table')).getByText(/^(Found|Contacted|Responded|Qualified|Proposal|Lost)$/);

    async function log(label) {
      fireEvent.click(within(region).getByRole('button', { name: label }));
      await act(async () => { await vi.advanceTimersByTimeAsync(UNDO_MS); });
      await settle();
    }

    await settle();
    expect(stage()).toHaveValue('found');
    expect(within(column('Found')).getByText('TEST: Wasatch Heating')).toBeInTheDocument();
    expect(chip()).toHaveTextContent('Found');
    vi.useFakeTimers();
    fireEvent.click(within(region).getByRole('button', { name: 'Log TEST: Wasatch Heating' }));

    await log('No answer');
    expect(stage()).toHaveValue('found');
    expect(chip()).toHaveTextContent('Found');
    await log('Voicemail');
    expect(stage()).toHaveValue('found');
    await log('Do not contact');
    expect(stage()).toHaveValue('found');
    expect(within(column('Found')).getByText('TEST: Wasatch Heating')).toBeInTheDocument();

    await log('Talked');
    expect(stage()).toHaveValue('responded');
    expect(within(column('Responded')).getByText('TEST: Wasatch Heating')).toBeInTheDocument();
    expect(within(column('Found')).queryByText('TEST: Wasatch Heating')).not.toBeInTheDocument();
    expect(chip()).toHaveTextContent('Responded');

    await log('Audit booked');
    expect(stage()).toHaveValue('qualified');
    expect(within(column('Qualified')).getByText('TEST: Wasatch Heating')).toBeInTheDocument();
    expect(chip()).toHaveTextContent('Qualified');

    await log('Not interested');
    expect(stage()).toHaveValue('lost');
    expect(within(column('Qualified')).queryByText('TEST: Wasatch Heating')).not.toBeInTheDocument();
    expect(chip()).toHaveTextContent('Lost');
    vi.useRealTimers();
  });
});

describe('call list helpers and tokens', () => {
  it('reads the marker only when the field is present', () => {
    expect(readCallListKind({})).toEqual({ present: false, kind: null });
    expect(readCallListKind({ [CALL_LIST_KIND_FIELD]: null })).toEqual({ present: true, kind: null });
    expect(readCallListKind({ [CALL_LIST_KIND_FIELD]: 'call' }).kind).toBe('call');
    expect(readCallListKind({ [CALL_LIST_KIND_FIELD]: 'walk_in' }).kind).toBe('walk_in');
    expect(readCallListKind({ [CALL_LIST_KIND_FIELD]: 'excluded' }).kind).toBe('excluded');
    expect(readCallListKind({ [CALL_LIST_KIND_FIELD]: 'nope' })).toEqual({ present: true, kind: null });
    expect(CALL_LIST_KIND_FIELD).toBe('call_list_kind');
  });

  it('keeps tel and https map links and drops anything else', async () => {
    expect(safeTel({ tel: 'tel:8015550142' })).toBe('tel:8015550142');
    expect(safeTel({ tel: 'javascript:alert(1)', phone: '(801) 555-0100' })).toBe('tel:8015550100');
    expect(safeTel({ phone: '' })).toBeNull();
    expect(safeMaps({ maps_url: 'https://www.google.com/maps/search/?api=1&query=Shop' })).toBe('https://www.google.com/maps/search/?api=1&query=Shop');
    expect(safeMaps({ maps_url: 'javascript:alert(1)', company: 'TEST: Shop', address: '1 Test St' }))
      .toBe('https://www.google.com/maps/search/?api=1&query=TEST%3A%20Shop%201%20Test%20St');
    expect(safeMaps({ maps_url: 'http://maps.example/x', company: 'TEST: Shop' })).toMatch(/^https:\/\/www\.google\.com\/maps\/search\//);
    const denver = new Date('2026-11-20T18:00:00.000Z');
    expect(backOnLabel('2026-11-23', denver)).toBe('Back on Mon');
    expect(backOnLabel('2026-11-26', denver)).toBe('Back on Thu');
    expect(backOnLabel('2026-11-27', denver)).toBe('Back on Nov 27');
    expect(backOnLabel('2026-11-14', denver)).toBe('Back on Sat');
    expect(backOnLabel(null, denver)).toBeNull();
    expect(callListErrorMessage(Object.assign(new Error('do_not_contact'), { status: 409 }))).toBe('This lead is on do-not-contact');
    expect(callListErrorMessage(Object.assign(new Error('archived'), { status: 409 }))).toBe('This lead is archived');
    expect(callListErrorMessage(Object.assign(new Error('invalid_kind'), { status: 400 }))).toBe('Pick a call or a walk-in.');
    expect(callListErrorMessage(Object.assign(new Error('invalid_outcome'), { status: 400 }))).toBe('That outcome isn\'t available.');
    expect(callListErrorMessage(Object.assign(new Error('not_found'), { status: 404 }))).toBe('Call list isn\'t available.');
    const marked = applyMarkerResponse(
      { id: 11 },
      { call_list_kind: 'excluded', call_list_set_at: '2026-11-20T18:00:00.000Z' },
      'call',
    );
    expect(marked[CALL_LIST_KIND_FIELD]).toBe('excluded');
    expect(marked[CALL_LIST_SET_AT_FIELD]).toBe('2026-11-20T18:00:00.000Z');
    expect(CALL_LIST_SET_AT_FIELD).toBe('call_list_set_at');
    resetCallListMock();
    await expect(api.saveCallListKind(11, 'call')).rejects.toMatchObject({ message: 'not_found', status: 404 });
    await expect(api.removeCallList(11)).rejects.toMatchObject({ message: 'not_found', status: 404 });
    await expect(api.recordCallOutcome(11, { outcome: 'talked', kind: 'call' })).rejects.toMatchObject({ message: 'not_found', status: 404 });
    const hidden = presentProspectKeys({
      id: 11,
      company: 'TEST: Wasatch Heating',
      call_list_kind: 'call',
      call_list_set_at: '2026-11-20T18:00:00.000Z',
    }, false);
    expect(hidden).not.toHaveProperty('call_list_kind');
    expect(hidden).not.toHaveProperty('call_list_set_at');
    const shown = presentProspectKeys({ id: 11, company: 'TEST: Wasatch Heating', call_list_kind: 'excluded' }, true);
    expect(shown.call_list_kind).toBe('excluded');
  });

  it('uses Scout copy in fixtures and never mentions a view in a script', () => {
    const scripts = [SCOUT_COPY.callEmailed, SCOUT_COPY.callNeverEmailed, SCOUT_COPY.voicemail, SCOUT_COPY.walkIn, SCOUT_COPY.ask];
    for (const line of scripts) expect(line).not.toMatch(/viewed|opened/i);
    expect(CALL_REASONS.demo_today).toBe('Viewed the demo today');
    expect(CALL_REASONS.demo_view).toBe('Viewed the demo yesterday');
    expect(CALL_REASONS.demo_days).toBe('Viewed the demo 3 days ago');
    expect(CALL_REASONS.intro_3_5d).toBe('Intro email 4 days ago, no reply');
    expect(CALL_REASONS.listedCall).toBe('On your call list');
    expect(CALL_REASONS.listedWalkIn).toBe('On your walk-in list');
    expect(CALL_REASONS.sequence_done).toBe('Emails finished, no reply');
    expect(CALL_REASONS.no_answer).toBe('No answer Mon, try again');
    expect(CALL_REASONS.voicemail).toBe('Left a voicemail Tue');
    expect(CALL_REASONS.talked).toBe('Talked Nov 19, follow up');
    expect(CALL_REASONS.stoppedBy).toBe('Stopped by Wed, try again');
    expect(panelSource).not.toContain('Viewed the demo');
    expect(panelSource).not.toContain('try again');
    expect(panelSource).not.toContain('On your call list');
    expect(SCOUT_COPY.voicemail).not.toMatch(/tomorrow/i);
  });

  it('keeps outcome controls at 44px in a two-column grid and uses River Valley tokens', () => {
    const block = css.slice(css.indexOf('/* call-list:start */'), css.indexOf('/* call-list:end */'));
    expect(block).toContain('min-height: 44px');
    expect(block).toContain('min-width: 44px');
    expect(block).toContain('grid-template-columns: 1fr 1fr');
    expect(block).toContain('-webkit-line-clamp: 2');
    expect(block).toContain('.call-list-hold');
    expect(block).toContain('grid-column: 1 / -1');
    expect(block).toContain('border-top: 1px solid var(--line)');
    expect(block).toContain('background: var(--ochre-wash)');
    expect(block).toContain('color: var(--rust)');
    expect(block).toContain('border-color: var(--rust)');
    expect(block).not.toContain('background: var(--rust-wash)');
    expect(block).not.toMatch(/#[0-9A-Fa-f]{3,8}/);
    const root = css.slice(css.indexOf(':root {'), css.indexOf('@media (prefers-color-scheme: dark)'));
    const hex = (name) => root.match(new RegExp(`${name}:\\s*(#[0-9A-Fa-f]{6})`))[1];
    const mutedOnPaper = contrast(hex('--ink-2'), hex('--paper'));
    expect(mutedOnPaper).toBeGreaterThanOrEqual(4.5);
    expect(mutedOnPaper).toBeCloseTo(5.58, 1);
    expect(contrast(hex('--ink-2'), hex('--surface'))).toBeGreaterThanOrEqual(4.5);
    expect(contrast(hex('--ink'), hex('--ochre-wash'))).toBeGreaterThanOrEqual(4.5);
    expect(contrast(hex('--ink'), hex('--rust-wash'))).toBeGreaterThanOrEqual(4.5);
    expect(contrast(hex('--rust'), hex('--surface'))).toBeGreaterThanOrEqual(4.5);
  });
});

function contrast(foreground, background) {
  const L = (hex) => {
    const n = parseInt(hex.slice(1), 16);
    const channel = (value) => {
      const c = value / 255;
      return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    };
    const r = channel((n >> 16) & 255);
    const g = channel((n >> 8) & 255);
    const b = channel(n & 255);
    return (0.2126 * r) + (0.7152 * g) + (0.0722 * b);
  };
  const hi = Math.max(L(foreground), L(background));
  const lo = Math.min(L(foreground), L(background));
  return (hi + 0.05) / (lo + 0.05);
}
