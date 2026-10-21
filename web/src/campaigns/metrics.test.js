import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { PRODUCTION_HOSTS } from '../api-base.js';
import { listCampaigns } from './client.js';
import { HVAC_OCT, PROTO_OCT } from './fixture.js';
import {
  dateRanges,
  campaignInRange,
  footnote,
  formatCampaignDates,
  formatRatePercent,
  headlineMetrics,
  machineOpenLine,
  onlyTestCampaigns,
  sortCampaigns,
  untouchedMessage,
} from './metrics.js';
import { moreBadge, railItems, resolveRoute, tabIsOn, tabItems } from './nav.js';

const here = path.dirname(fileURLToPath(import.meta.url));

function loc(href) {
  const url = new URL(href);
  return { protocol: url.protocol, port: url.port, hostname: url.hostname, search: url.search };
}

describe('campaign headline math', () => {
  it('matches the #67 TEST: HVAC-Oct fixture, including a reply on another channel', () => {
    const metrics = headlineMetrics(HVAC_OCT);
    expect(metrics).toMatchObject({
      enrolled: 8,
      touched: 8,
      responded: 3,
      converted: 1,
      openedNoReply: 1,
      machineOpens: 1,
    });
    expect(formatRatePercent(metrics.responded, metrics.touched)).toBe('37.5%');
    expect(formatRatePercent(metrics.converted, metrics.touched)).toBe('12.5%');
    expect(formatRatePercent(metrics.openedNoReply, metrics.touched)).toBe('12.5%');

    const withMachine = headlineMetrics(HVAC_OCT, { includeMachineOpens: true });
    expect(withMachine.openedNoReply).toBe(2);
    expect(withMachine.machineOpens).toBe(1);
    expect(formatRatePercent(withMachine.openedNoReply, withMachine.touched)).toBe('25%');
    expect(withMachine.responded).toBe(3);
    expect(withMachine.converted).toBe(1);

    const sold = HVAC_OCT.leads.filter((lead) => lead.touches.some((touch) => touch.type === 'mvp_sold'));
    expect(sold).toHaveLength(1);
    expect(sold[0].touches.some((touch) => touch.type === 'won')).toBe(false);
    expect(HVAC_OCT.leads.some((lead) => lead.touches.some((touch) => touch.type === 'replied' && touch.channel === 'phone'))).toBe(true);
  });

  it('uses leads touched as the responded denominator, not every enrolled lead', () => {
    const campaign = {
      name: 'TEST: Partial',
      leads: [
        { id: 'a', touches: [{ type: 'sent' }, { type: 'replied', channel: 'email' }] },
        { id: 'b', touches: [{ type: 'sent' }] },
        { id: 'c', touches: [{ type: 'prototype_viewed' }] },
        { id: 'd', touches: [] },
      ],
    };
    const metrics = headlineMetrics(campaign);
    expect(metrics.enrolled).toBe(4);
    expect(metrics.touched).toBe(2);
    expect(metrics.responded).toBe(1);
    expect(formatRatePercent(metrics.responded, metrics.touched)).toBe('50%');
    expect(formatRatePercent(metrics.responded, metrics.enrolled)).toBe('25%');
    expect(machineOpenLine(1, metrics.touched, false)).toBe('1 of 2 machine opens, no reply, excluded');
    expect(machineOpenLine(1, metrics.touched, true)).toBe('1 of 2 machine opens, no reply, included');
  });

  it('does not count a prototype view as a touch', () => {
    const metrics = headlineMetrics(PROTO_OCT);
    expect(metrics).toMatchObject({ enrolled: 1, touched: 0, prototypeViews: 1, responded: 0, converted: 0 });
    expect(untouchedMessage(metrics)).toBe("No sent or call-logged touches yet. 1 prototype view is tracked but isn't a touch for these rates.");
    expect(formatRatePercent(0, 0)).toBe('—');
  });

  it('keeps opens out of responded and converted', () => {
    const campaign = {
      name: 'TEST: Opens',
      leads: [
        { id: 'A', touches: [{ type: 'sent' }, { type: 'opened', machineOpen: false }, { type: 'replied', channel: 'sms' }] },
        { id: 'B', touches: [{ type: 'sent' }, { type: 'opened', machineOpen: true }] },
        { id: 'C', touches: [{ type: 'call_logged', channel: 'phone' }, { type: 'won' }] },
      ],
    };
    const metrics = headlineMetrics(campaign);
    expect(metrics.touched).toBe(3);
    expect(metrics.responded).toBe(1);
    expect(metrics.converted).toBe(1);
    expect(metrics.openedNoReply).toBe(0);
    expect(metrics.machineOpens).toBe(1);
    expect(headlineMetrics(campaign, { includeMachineOpens: true }).openedNoReply).toBe(1);
    expect(headlineMetrics(campaign, { includeMachineOpens: true }).converted).toBe(1);
  });

  it('sorts active campaigns first, then newest start date', () => {
    const rows = sortCampaigns([
      { name: 'TEST: Plumbing-Sep walk-ins', status: 'ended', startDate: '2026-09-02' },
      { name: 'TEST: HVAC-Oct', status: 'active', startDate: '2026-09-24' },
      { name: 'TEST: HVAC-Nov', status: 'draft', startDate: '2026-11-03' },
      { name: 'TEST: Proto-Oct furnace-tune-up estimate follow-up demo link', status: 'active', startDate: '2026-10-03' },
    ]);
    expect(rows.map((row) => row.name)).toEqual([
      'TEST: Proto-Oct furnace-tune-up estimate follow-up demo link',
      'TEST: HVAC-Oct',
      'TEST: HVAC-Nov',
      'TEST: Plumbing-Sep walk-ins',
    ]);
  });

  it('formats dates and drops rows that are not TEST:', () => {
    expect(formatCampaignDates('2026-11-03', null)).toBe('Nov 3 – not set');
    expect(formatCampaignDates('2026-09-24', '2026-10-31')).toBe('Sep 24 – Oct 31');
    expect(onlyTestCampaigns([
      { name: 'Acme Heating' },
      { name: 'TEST: HVAC-Oct' },
      { name: 'Contest: HVAC' },
      { name: 'test: lowercase' },
    ]).map((row) => row.name)).toEqual(['TEST: HVAC-Oct']);
    expect(campaignInRange({ startDate: '2026-11-03', endDate: null }, { from: '2026-12-01', to: '2026-12-31' })).toBe(true);
    expect(campaignInRange({ startDate: '2026-11-03', endDate: null }, { from: '2026-01-01', to: '2026-01-31' })).toBe(false);
    expect(footnote({ includeMachineOpens: false })).toMatch(/likely-human only/);
    expect(footnote({ includeMachineOpens: true })).toMatch(/including machine opens/);
  });
});

describe('campaigns client', () => {
  const apiRow = {
    id: 3,
    name: 'TEST: HVAC-Oct',
    status: 'active',
    channel: 'email',
    start_date: '2026-09-24',
    end_date: null,
    segment: 'hvac',
    enrolled: 8,
    touched: 8,
    responded: 3,
    converted: 1,
    opened_no_response_human: 1,
    opened_no_response_incl_machine: 2,
    machine_opens: 1,
    prototype_views: 0,
    cost_cents: 6000,
  };

  it('reads GET /api/campaigns with the range, maps rows, and never fetches directly', async () => {
    const calls = [];
    const get = async (path) => { calls.push(path); return { campaigns: [apiRow, null] }; };
    const prod = loc(`https://${PRODUCTION_HOSTS[0]}/`);
    const result = await listCampaigns({ location: prod, env: { DEV: false }, get });
    expect(calls).toEqual(['/api/campaigns']);
    expect(result.endpoint).toBe('/api/campaigns');
    expect(result.campaigns).toEqual([{
      id: 3,
      name: 'TEST: HVAC-Oct',
      channel: 'email',
      segment: 'hvac',
      status: 'active',
      startDate: '2026-09-24',
      endDate: null,
      costCents: 6000,
      counts: {
        enrolled: 8,
        touched: 8,
        responded: 3,
        converted: 1,
        openedNoReplyHuman: 1,
        openedNoReplyAll: 2,
        machineOpens: 1,
        prototypeViews: 0,
      },
    }]);
    const metrics = headlineMetrics(result.campaigns[0], { includeMachineOpens: false });
    expect(metrics).toMatchObject({ touched: 8, responded: 3, converted: 1, openedNoReply: 1, machineOpens: 1 });
    expect(headlineMetrics(result.campaigns[0], { includeMachineOpens: true }).openedNoReply).toBe(2);

    await listCampaigns({ location: prod, env: { DEV: false }, get, range: { from: '2026-10-01', to: '2026-10-20' } });
    await listCampaigns({ location: prod, env: { DEV: false }, get, range: { from: '2026-10-01; DROP', to: null } });
    expect(calls.slice(1)).toEqual(['/api/campaigns?from=2026-10-01&to=2026-10-20', '/api/campaigns']);

    await expect(listCampaigns({ location: prod, env: { DEV: false }, get: async () => ({ campaigns: {} }) }))
      .rejects.toThrow(/campaigns_unavailable/);
    const source = readFileSync(path.join(here, 'client.js'), 'utf8');
    expect(source).not.toMatch(/fetch\s*\(/);
    expect(source).not.toMatch(/axios|send\.js|gmail/);
    const view = readFileSync(path.join(here, '../views/Campaigns.jsx'), 'utf8');
    expect(view).not.toMatch(/send\.js|gmail|fetch\s*\(/);
  });

  it('honors preview empty, error, loading, and fixture only where flag overrides are allowed', async () => {
    const calls = [];
    const get = async (path) => { calls.push(path); return { campaigns: [apiRow] }; };
    const empty = await listCampaigns({
      location: loc('http://localhost:5173/?campaigns=empty'),
      env: { DEV: true },
      get,
    });
    expect(empty.campaigns).toEqual([]);
    await expect(listCampaigns({
      location: loc('http://localhost:5173/?campaigns=error'),
      env: { DEV: true },
      get,
    })).rejects.toThrow(/campaigns_unavailable/);

    let settled = false;
    const pending = listCampaigns({
      location: loc('http://localhost:5173/?campaigns=loading'),
      env: { DEV: true },
      get,
    });
    pending.then(() => { settled = true; }, () => { settled = true; });
    await new Promise((resolve) => { setTimeout(resolve, 20); });
    expect(settled).toBe(false);

    const fixture = await listCampaigns({
      location: loc('http://localhost:5173/?campaigns=fixture'),
      env: { DEV: true },
      get,
    });
    expect(fixture.campaigns.map((row) => row.name)).toEqual([
      'TEST: HVAC-Oct',
      'TEST: Proto-Oct furnace-tune-up estimate follow-up demo link',
      'TEST: Plumbing-Sep walk-ins',
      'TEST: HVAC-Nov',
    ]);
    expect(calls).toEqual([]);

    const host = PRODUCTION_HOSTS[0];
    for (const state of ['empty', 'error', 'loading', 'fixture']) {
      const production = await listCampaigns({
        location: loc(`https://${host}/?campaigns=${state}`),
        env: { DEV: true },
        get,
      });
      expect(production.campaigns.map((row) => row.id)).toEqual([3]);
    }
    expect(calls.length).toBe(4);
  });

  it('builds date ranges relative to today', () => {
    expect(dateRanges(new Date(2026, 9, 20))).toEqual([
      { id: 'lifetime', label: 'All dates', from: null, to: null },
      { id: 'last30', label: 'Last 30 days', from: '2026-09-21', to: '2026-10-20' },
      { id: 'month', label: 'This month', from: '2026-10-01', to: '2026-10-20' },
      { id: 'lastMonth', label: 'Last month', from: '2026-09-01', to: '2026-09-30' },
    ]);
    expect(dateRanges(new Date(2027, 0, 5)).find((item) => item.id === 'lastMonth'))
      .toMatchObject({ from: '2026-12-01', to: '2026-12-31' });
  });
});

describe('campaigns navigation helpers', () => {
  it('keeps the current rail and tabs when the flag is off', () => {
    expect(railItems(false).map((item) => item.label)).toEqual([
      'Today', 'Leads', 'Proposals', 'Inbox', 'Pipeline', 'Projects', 'Settings',
    ]);
    expect(tabItems(false).map((item) => item.label)).toEqual([
      'Today', 'Leads', 'Pipeline', 'Proposals', 'More',
    ]);
    expect(tabIsOn('proposals', 'proposals', false)).toBe(true);
    expect(tabIsOn('more', 'proposals', false)).toBe(false);
    expect(tabIsOn('more', 'projects', false)).toBe(true);
    expect(resolveRoute('#/campaigns', { campaigns: false, hasKey: true })).toBe('not-found');
    expect(moreBadge({ campaignsOn: false, proposalsN: 2, overdueN: 1 }).proposals.n).toBe(2);
    expect(moreBadge({ campaignsOn: false, proposalsN: 2, overdueN: 1 }).more.n).toBe(1);
    expect(tabIsOn('more', 'inbox', false)).toBe(true);
    expect(resolveRoute('#/inbox', { campaigns: false, hasKey: true })).toBe('inbox');
    expect(moreBadge({ campaignsOn: false, proposalsN: 2, overdueN: 1, inboxN: 3 }).more).toEqual({ n: 4, label: '4 replies and overdue tasks' });
  });

  it('puts Campaigns between Pipeline and Proposals and rolls the proposals badge onto More', () => {
    expect(railItems(true).map((item) => item.label)).toEqual([
      'Today', 'Leads', 'Pipeline', 'Campaigns', 'Proposals', 'Inbox', 'Projects', 'Settings',
    ]);
    expect(tabItems(true).map((item) => item.label)).toEqual([
      'Today', 'Leads', 'Pipeline', 'Campaigns', 'More',
    ]);
    expect(tabIsOn('more', 'proposals', true)).toBe(true);
    expect(tabIsOn('campaigns', 'campaigns', true)).toBe(true);
    expect(tabItems(true).some((item) => item.id === 'proposals')).toBe(false);
    expect(resolveRoute('#/campaigns', { campaigns: true, hasKey: true })).toBe('campaigns');
    expect(resolveRoute('#/campaigns/test-hvac-oct', { campaigns: true, hasKey: true })).toBe('not-found');
    const badge = moreBadge({ campaignsOn: true, proposalsN: 14, overdueN: 4 });
    expect(badge.proposals).toBeNull();
    expect(badge.more).toEqual({ n: 18, label: '14 proposals to review, 4 overdue project tasks' });
    expect(tabIsOn('more', 'inbox', true)).toBe(true);
    expect(moreBadge({ campaignsOn: true, proposalsN: 1, overdueN: 2, inboxN: 3 }).more)
      .toEqual({ n: 6, label: '1 proposals to review, 3 replies waiting, 2 overdue project tasks' });
  });
});
