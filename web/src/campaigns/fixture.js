// TEST: fixture for F-006 slice 1. Numbers follow issue #67 §3 and the
// headline-metric addendum (comment 6220922709), with the design's list rows
// from docs/design/campaigns.md §0.1 and §2. Nothing here is a real lead.

function lead(id, variant, touches) {
  return { id, variant, touches };
}

function touch(type, extra = {}) {
  return { type, channel: extra.channel || 'email', ...extra };
}

/** #67 §3 `TEST: HVAC-Oct`: 8 touched leads, all sent on day 0. */
export const HVAC_OCT = {
  id: 'test-hvac-oct',
  name: 'TEST: HVAC-Oct',
  channel: 'email',
  segment: 'hvac',
  status: 'active',
  startDate: '2026-09-24',
  endDate: '2026-10-31',
  costCents: 6000,
  leads: [
    lead('L1', 'A', [
      touch('sent', { day: 0 }),
      touch('replied', { day: 2 }),
      touch('call_booked', { channel: 'phone', day: 5 }),
      touch('mvp_sold', { day: 20, revenueCents: 150000 }),
    ]),
    lead('L2', 'A', [
      touch('sent', { day: 0 }),
      touch('replied', { day: 4 }),
    ]),
    lead('L3', 'A', [
      touch('sent', { day: 0 }),
      touch('opened', { day: 1, machineOpen: false }),
    ]),
    lead('L4', 'A', [
      touch('sent', { day: 0 }),
    ]),
    lead('L5', 'B', [
      touch('sent', { day: 0 }),
      // A reply on a different channel still counts at campaign level.
      touch('replied', { channel: 'phone', day: 6 }),
      touch('call_booked', { channel: 'phone', day: 8 }),
    ]),
    lead('L6', 'B', [
      touch('sent', { day: 0 }),
      touch('opened', { day: 2, machineOpen: true }),
    ]),
    lead('L7', 'B', [touch('sent', { day: 0 })]),
    lead('L8', 'B', [touch('sent', { day: 0 })]),
  ],
};

/** Scout's corrected Proto-Oct: the only event is a prototype view, so touched is 0. */
export const PROTO_OCT = {
  id: 'test-proto-oct',
  name: 'TEST: Proto-Oct furnace-tune-up estimate follow-up demo link',
  channel: 'prototype_link',
  segment: 'hvac',
  status: 'active',
  startDate: '2026-10-03',
  endDate: '2026-11-15',
  costCents: null,
  leads: [
    lead('L2', null, [
      touch('prototype_viewed', { channel: 'prototype_link', day: 3 }),
    ]),
  ],
};

export const PLUMBING_SEP = {
  id: 'test-plumbing-sep',
  name: 'TEST: Plumbing-Sep walk-ins',
  channel: 'in_person',
  segment: 'plumbing',
  status: 'ended',
  startDate: '2026-09-02',
  endDate: '2026-09-30',
  costCents: null,
  leads: [],
};

export const HVAC_NOV = {
  id: 'test-hvac-nov',
  name: 'TEST: HVAC-Nov',
  channel: 'email',
  segment: 'hvac',
  status: 'draft',
  startDate: '2026-11-03',
  endDate: null,
  costCents: null,
  leads: [],
};

export const FIXTURE_CAMPAIGNS = Object.freeze([
  HVAC_OCT,
  PROTO_OCT,
  PLUMBING_SEP,
  HVAC_NOV,
]);

export const DATE_RANGES = Object.freeze([
  { id: 'lifetime', label: 'Sep 24 – Oct 16', from: null, to: null },
  { id: 'sep', label: 'Sep 1 – Sep 30', from: '2026-09-01', to: '2026-09-30' },
  { id: 'oct', label: 'Oct 1 – Oct 16', from: '2026-10-01', to: '2026-10-16' },
  { id: 'jan', label: 'Jan 1 – Jan 31', from: '2026-01-01', to: '2026-01-31' },
]);

export const STATUS_FILTERS = Object.freeze([
  { id: 'all', label: 'All' },
  { id: 'active', label: 'Active' },
  { id: 'paused', label: 'Paused' },
  { id: 'ended', label: 'Ended' },
  { id: 'draft', label: 'Draft' },
]);
