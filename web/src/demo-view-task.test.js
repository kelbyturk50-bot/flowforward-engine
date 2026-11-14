import { describe, expect, it } from 'vitest';
import {
  actionMessage,
  callHref,
  denverWhen,
  isTaskListHidden,
  phoneText,
  snoozeLabel,
  snoozeStillHeld,
  taskPathId,
  taskSubline,
  taskTitle,
  tasksFromPayload,
  viewCount,
} from './demo-view-task.js';

const NOW = new Date('2026-11-14T18:00:00.000Z');

describe('demo-view task ids', () => {
  it('keeps a safe positive integer and rejects a path', () => {
    expect(taskPathId(1)).toBe('1');
    expect(taskPathId('20')).toBe('20');
    expect(taskPathId('1/done')).toBeNull();
    expect(taskPathId('../1')).toBeNull();
    expect(taskPathId('01')).toBeNull();
    expect(taskPathId(0)).toBeNull();
    expect(taskPathId(1.5)).toBeNull();
    expect(taskPathId(-3)).toBeNull();
    expect(taskPathId(true)).toBeNull();
    expect(taskPathId('9007199254740993')).toBeNull();
  });
});

describe('demo-view task list hidden', () => {
  it('treats the flag-off 404 as hidden and leaves other failures visible', () => {
    expect(isTaskListHidden(Object.assign(new Error('not_found'), { status: 404 }))).toBe(true);
    expect(isTaskListHidden(Object.assign(new Error('Request failed (404)'), { status: 404 }))).toBe(true);
    expect(isTaskListHidden(Object.assign(new Error(''), { status: 404 }))).toBe(true);
    expect(isTaskListHidden(Object.assign(new Error('not_found'), { status: 500 }))).toBe(false);
    expect(isTaskListHidden(Object.assign(new Error('Something went wrong.'), { status: 500 }))).toBe(false);
    expect(isTaskListHidden(Object.assign(new Error('task_not_open'), { status: 409 }))).toBe(false);
    expect(isTaskListHidden(null)).toBe(false);
  });
});

describe('demo-view task copy', () => {
  const task = {
    company: 'TEST: Wasatch Heating',
    view_count: 2,
    last_viewed_at: '2026-11-14T21:14:00.000Z',
    source: 'onepager',
    trade: 'HVAC',
    city: 'Provo',
    phone: '(801) 555-0142',
  };

  it('builds the title in Kelby\'s words, with a singular time', () => {
    expect(taskTitle(task)).toBe('Call TEST: Wasatch Heating: viewed your proposal 2 times');
    expect(taskTitle({ ...task, view_count: 1 })).toBe('Call TEST: Wasatch Heating: viewed your proposal 1 time');
    expect(taskTitle({ ...task, view_count: '4' })).toBe('Call TEST: Wasatch Heating: viewed your proposal 4 times');
    expect(taskTitle({ company: '  ', view_count: 2 })).toBe('Call this lead: viewed your proposal 2 times');
    expect(viewCount(0)).toBeNull();
    expect(viewCount('nope')).toBeNull();
  });

  it('formats the Denver subline for today, yesterday, and a later day', () => {
    expect(denverWhen('2026-11-14T21:14:00.000Z', NOW)).toBe('today 2:14 PM');
    expect(denverWhen('2026-11-13T15:05:00.000Z', NOW)).toBe('yesterday 8:05 AM');
    expect(denverWhen('2026-11-15T21:14:00.000Z', NOW)).toBe('tomorrow 2:14 PM');
    expect(denverWhen('2026-11-02T21:14:00.000Z', NOW)).toBe('Nov 2, 2:14 PM');
    expect(denverWhen('2025-12-31T21:14:00.000Z', NOW)).toBe('Dec 31, 2025, 2:14 PM');
    expect(denverWhen('not-a-date', NOW)).toBe('');
    expect(taskSubline(task, NOW)).toBe('today 2:14 PM · proposal · HVAC · Provo');
    expect(taskSubline({ ...task, source: 'demo', trade: '', city: 'Ogden' }, NOW))
      .toBe('today 2:14 PM · live demo · Ogden');
  });

  it('uses the Denver calendar when UTC has already rolled to the next day', () => {
    const late = new Date('2026-11-15T05:30:00.000Z');
    expect(denverWhen('2026-11-15T03:14:00.000Z', late)).toBe('today 8:14 PM');
    const nextMorning = new Date('2026-11-15T18:00:00.000Z');
    expect(denverWhen('2026-11-15T03:14:00.000Z', nextMorning)).toBe('yesterday 8:14 PM');
  });

  it('stays on Denver time in July', () => {
    const summer = new Date('2026-07-14T18:00:00.000Z');
    expect(denverWhen('2026-07-14T20:14:00.000Z', summer)).toBe('today 2:14 PM');
  });

  it('dials a stored phone and treats a blank or word-only value as no phone', () => {
    expect(callHref('(801) 555-0142')).toBe('tel:8015550142');
    expect(phoneText('(801) 555-0142')).toBe('(801) 555-0142');
    expect(callHref('   ')).toBeNull();
    expect(callHref(null)).toBeNull();
    expect(callHref('call the shop')).toBeNull();
    expect(phoneText('call the shop')).toBe('');
    expect(callHref('+18015550142')).toBe('tel:+18015550142');
  });

  it('labels a snooze from snoozed_until', () => {
    expect(snoozeLabel('2026-11-15T21:14:00.000Z', NOW)).toBe('Snoozed until tomorrow 2:14 PM');
    expect(snoozeLabel(null, NOW)).toBe('Snoozed for 1 day');
    expect(snoozeStillHeld('2026-11-15T21:14:00.000Z', NOW)).toBe(true);
    expect(snoozeStillHeld('2026-11-14T17:00:00.000Z', NOW)).toBe(false);
    expect(snoozeStillHeld(null, NOW)).toBe(true);
  });

  it('drops a row that has no task id', () => {
    expect(tasksFromPayload({ tasks: [task, { company: 'TEST: Skip' }, null] })).toEqual([]);
    expect(tasksFromPayload({ tasks: [{ ...task, id: 7 }] })).toHaveLength(1);
    expect(tasksFromPayload(null)).toEqual([]);
    expect(tasksFromPayload({ tasks: 'nope' })).toEqual([]);
  });

  it('turns action codes into sentences', () => {
    expect(actionMessage(Object.assign(new Error('task_not_open'), { status: 409 })))
      .toBe('That call was already handled.');
    expect(actionMessage(Object.assign(new Error('Something went wrong.'), { status: 500 })))
      .toBe('Something went wrong.');
    expect(actionMessage(Object.assign(new Error('not_found'), { status: 404 })))
      .toBe('Something went wrong.');
  });
});
