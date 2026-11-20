import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DOCS = path.resolve(HERE, '../../docs/screenshots/f009-reply-warning');
const ARTIFACTS = '/opt/cursor/artifacts';

const REPLIED_AT = '2026-09-22T15:04:00.000Z';
const WARNING = 'This lead replied to another proposal on Sep 22, 2026, 9:04 AM MT. Check that reply before sending again.';

const cors = {
  'access-control-allow-origin': 'http://localhost:5173',
  'access-control-allow-headers': 'content-type, x-api-key',
  'access-control-allow-methods': 'GET, POST, PATCH, PUT, DELETE, OPTIONS',
};

function draft(extra = {}) {
  return {
    id: 9,
    prospect_id: 11,
    company: 'TEST: Wasatch Heating',
    industry: 'HVAC',
    city: 'Provo',
    state: 'UT',
    to_email: 'test+owner@example.test',
    to_name: 'Sam',
    subject: 'Missed after-hours calls',
    body: 'Hi Sam,\n\nA short note about missed calls after hours.\n\nKelby',
    followup1: 'Checking in.\n\nKelby',
    followup2: 'Last note.\n\nKelby',
    status: 'draft',
    stop_reason: null,
    error: null,
    fit_score: 86,
    fit_tier: 'A',
    fit_verdict: 'strong',
    reviewed_at: '2026-11-19T17:00:00.000Z',
    version: 2,
    cost_usd: 0.12,
    rating: 4.8,
    review_count: 80,
    analysis: { snapshot: 'Owner-operated shop, about eight trucks.', fit_verdict: 'good' },
    versions: [
      { id: 9, version: 2, status: 'draft' },
      { id: 42, version: 1, status: 'replied' },
    ],
    preview: {},
    onepager: { observations: ['Missed calls'], opportunities: ['Text-back'] },
    onepager_url: 'https://example.test/p/wasatch',
    created_at: '2026-11-19T16:00:00.000Z',
    updated_at: '2026-11-19T16:30:00.000Z',
    prototype: null,
    ...extra,
  };
}

function sibling() {
  return draft({
    id: 42,
    version: 1,
    status: 'replied',
    subject: 'Earlier note',
    replied_at: REPLIED_AT,
    sent_at: '2026-09-20T15:00:00.000Z',
    updated_at: REPLIED_AT,
    versions: [
      { id: 9, version: 2, status: 'draft' },
      { id: 42, version: 1, status: 'replied' },
    ],
  });
}

const summary = {
  eligible_leads: 1,
  daily_limit: 20,
  sent_today: 0,
  spend_this_month: 0.12,
  running: false,
  setup: [],
  halt: null,
  counts: { review: 1, out: 0, replied: 1, flagged: 0, closed: 0 },
  config: {
    tiers: ['A'],
    auto_draft: false,
    excluded: ['Pest Control'],
    reviews: false,
    web_search: false,
    model: 'test-model',
    nightly_count: 0,
    cron: '0 3 * * *',
    followup_days: [3, 10],
    sender: { name: 'Test Sender', email: 'sender@example.test', calendly: 'https://example.test/book', address: '1 Test St' },
  },
};

function json(route, status, body) {
  return route.fulfill({
    status,
    contentType: 'application/json',
    headers: cors,
    body: JSON.stringify(body),
  });
}

// `warn` is the flag-on recent_reply 409. Flag off leaves it false, so approve
// returns 200 the way main does.
async function boot(page, { warn = false } = {}) {
  const session = { status: 'draft', sends: [] };
  await page.addInitScript(() => {
    localStorage.setItem('ff.apiKey', 'screenshot-test-key-not-a-secret');
    localStorage.removeItem('ff.apiUrl');
  });
  await page.route('http://localhost:3000/**', async (route) => {
    const request = route.request();
    if (request.method() === 'OPTIONS') {
      await route.fulfill({ status: 204, headers: cors });
      return;
    }
    const url = new URL(request.url());
    const { pathname } = url;
    if (pathname === '/api/flags') {
      return json(route, 200, {
        flags: [{
          name: 'FF_APPROVE_REPLY_WARNING',
          enabled: false,
          effective: false,
          env_forced_off: false,
          writable: true,
          source: 'db',
          updated_at: null,
          updated_by: null,
        }],
      });
    }
    if (pathname === '/api/focus') {
      return json(route, 200, {
        counts: { proposals_to_review: 1, a_tier_open: 1, hot: 0, pipeline_value: 0, active_projects: 0, proposal_replies_7d: 0 },
        followups_due: [],
        top_new_leads: [],
        gone_quiet: [],
        task_queue: [],
      });
    }
    if (pathname === '/api/proposals/jobs') return json(route, 200, { jobs: [], unreviewed: 0 });
    if (pathname === '/api/proposals/summary') return json(route, 200, summary);
    if (pathname === '/api/demo-view-tasks') return json(route, 404, { error: 'not_found' });
    if (pathname === '/api/chat/facts') return json(route, 200, { facts: [] });
    if (pathname === '/api/inbox') return json(route, 200, { items: [], counts: { needs: 0, fyi: 0, handled: 0, working: 0, waiting: 0 } });
    if (pathname === '/api/prospects/meta') return json(route, 200, { industries: ['HVAC'], cities: ['Provo'] });
    if (pathname === '/api/prospects/stats') return json(route, 200, { by_stage: [], by_tier: [] });
    if (request.method() === 'POST' && pathname === '/api/proposals/9/send') {
      let body = {};
      try { body = request.postDataJSON() || {}; } catch { body = {}; }
      session.sends.push(body);
      if (warn && body.acknowledge_recent_reply !== true) {
        return json(route, 409, {
          error: 'recent_reply',
          sibling_proposal_id: 42,
          replied_at: REPLIED_AT,
        });
      }
      session.status = 'sent';
      return json(route, 200, draft({
        status: 'sent',
        sent_at: '2026-11-20T16:00:00.000Z',
        updated_at: '2026-11-20T16:00:00.000Z',
        versions: [
          { id: 9, version: 2, status: 'sent' },
          { id: 42, version: 1, status: 'replied' },
        ],
      }));
    }
    if (request.method() === 'POST' && pathname === '/api/proposals/9/seen') return json(route, 200, { ok: true });
    if (pathname === '/api/proposals') {
      const row = draft({ status: session.status });
      if (session.status === 'sent') row.sent_at = '2026-11-20T16:00:00.000Z';
      return json(route, 200, { proposals: [row] });
    }
    const detail = pathname.match(/^\/api\/proposals\/(\d+)$/);
    if (detail && request.method() === 'GET') {
      if (detail[1] === '42') return json(route, 200, sibling());
      if (detail[1] === '9') {
        return json(route, 200, draft({
          status: session.status,
          ...(session.status === 'sent' ? {
            sent_at: '2026-11-20T16:00:00.000Z',
            updated_at: '2026-11-20T16:00:00.000Z',
            versions: [
              { id: 9, version: 2, status: 'sent' },
              { id: 42, version: 1, status: 'replied' },
            ],
          } : {}),
        }));
      }
      return json(route, 404, { error: 'not_found' });
    }
    return json(route, 200, {});
  });
  return session;
}

async function openDraft(page) {
  await page.goto('/#/proposals');
  await page.getByRole('button', { name: /TEST: Wasatch Heating/ }).click();
  await expect(page.getByRole('dialog', { name: 'Proposal for TEST: Wasatch Heating' })).toBeVisible();
  await page.getByRole('button', { name: 'Approve and send' }).click();
  await expect(page.getByRole('alertdialog', { name: 'Confirm send' })).toBeVisible();
}

async function ready(page) {
  await page.evaluate(async () => { await document.fonts.ready; });
}

async function noOverflow(page) {
  const extra = await page.evaluate(() => {
    const pageExtra = document.documentElement.scrollWidth - document.documentElement.clientWidth;
    const drawer = document.querySelector('.drawer');
    const drawerExtra = drawer ? drawer.scrollWidth - drawer.clientWidth : 0;
    return Math.max(pageExtra, drawerExtra);
  });
  expect(extra).toBeLessThanOrEqual(1);
}

async function scrollIntoDrawer(page, selector) {
  await page.locator(selector).evaluate((node) => {
    const scroller = node.closest('.drawer') || document.scrollingElement;
    const bar = scroller.querySelector('.action-bar');
    const barHeight = bar ? bar.getBoundingClientRect().height : 0;
    const top = node.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop - barHeight - 12;
    scroller.scrollTop = Math.max(0, top);
  });
}

async function shoot(page, name) {
  await ready(page);
  await noOverflow(page);
  await page.screenshot({ path: path.join(DOCS, `${name}.png`) });
  await page.screenshot({ path: path.join(ARTIFACTS, `${name}.png`) });
}

test.describe('F-009 recent-reply warning screenshots', () => {
  test.use({ timezoneId: 'America/Denver', locale: 'en-US', colorScheme: 'light' });
  test.beforeAll(() => {
    mkdirSync(DOCS, { recursive: true });
    mkdirSync(ARTIFACTS, { recursive: true });
  });

  for (const width of [375, 1280]) {
    test(`before approve on main at ${width}`, async ({ page }) => {
      await page.setViewportSize({ width, height: width === 375 ? 812 : 900 });
      await boot(page, { warn: false });
      await openDraft(page);
      await expect(page.getByRole('button', { name: 'Send it' })).toBeVisible();
      await expect(page.getByText('Send anyway')).toHaveCount(0);
      await scrollIntoDrawer(page, '.confirm');
      await shoot(page, `before-approve-${width}`);
      await page.getByRole('button', { name: 'Send it' }).click();
      const drawer = page.getByRole('dialog', { name: 'Proposal for TEST: Wasatch Heating' });
      await expect(drawer.getByText('Out', { exact: true })).toBeVisible();
      await expect(page.getByRole('status').filter({ hasText: 'Sent to test+owner@example.test.' })).toBeVisible();
      await page.locator('.drawer').evaluate((el) => { el.scrollTop = 0; });
      await shoot(page, `before-sent-${width}`);
    });

    test(`warning, send anyway, and cancel at ${width}`, async ({ page }) => {
      await page.setViewportSize({ width, height: width === 375 ? 812 : 900 });
      const session = await boot(page, { warn: true });
      await openDraft(page);
      await page.getByRole('button', { name: 'Send it' }).click();
      const warning = page.locator('.reply-warning');
      await expect(warning).toHaveAttribute('role', 'alert');
      await expect(warning).toContainText(WARNING);
      await expect(page.getByRole('alertdialog', { name: 'Confirm send' })).toHaveCount(0);
      await expect(page.locator('.toast.show')).toHaveCount(0);
      const open = warning.getByRole('button', { name: 'Open that proposal' });
      const sendAnyway = warning.getByRole('button', { name: 'Send anyway' });
      const cancel = warning.getByRole('button', { name: 'Cancel' });
      await expect(open).toBeVisible();
      await expect(open).toHaveClass('btn');
      await expect(open).not.toHaveAttribute('target');
      await expect(sendAnyway).toHaveClass('btn btn-quiet');
      await expect(cancel).toHaveClass('btn btn-quiet');
      await expect(warning).toBeFocused();
      const boxes = await Promise.all([open.boundingBox(), sendAnyway.boundingBox(), cancel.boundingBox()]);
      for (const box of boxes) expect(box.height).toBeGreaterThanOrEqual(44);
      if (width === 375) {
        expect(boxes[0].y + boxes[0].height).toBeLessThanOrEqual(boxes[1].y + 1);
        expect(boxes[1].y + boxes[1].height).toBeLessThanOrEqual(boxes[2].y + 1);
        expect(Math.abs(boxes[0].width - boxes[1].width)).toBeLessThan(2);
        expect(Math.abs(boxes[1].width - boxes[2].width)).toBeLessThan(2);
        expect(boxes[0].width).toBeGreaterThan(width * 0.7);
      } else {
        expect(boxes[0].x + boxes[0].width).toBeLessThanOrEqual(boxes[1].x + 1);
        expect(boxes[1].x + boxes[1].width).toBeLessThanOrEqual(boxes[2].x + 1);
        expect(Math.abs(boxes[0].y - boxes[1].y)).toBeLessThan(4);
        expect(Math.abs(boxes[1].y - boxes[2].y)).toBeLessThan(4);
      }
      await scrollIntoDrawer(page, '.reply-warning');
      await shoot(page, `warning-${width}`);

      await sendAnyway.click();
      const drawer = page.getByRole('dialog', { name: 'Proposal for TEST: Wasatch Heating' });
      await expect(drawer.getByText('Out', { exact: true })).toBeVisible();
      await expect(page.getByRole('status').filter({ hasText: 'Sent to test+owner@example.test.' })).toBeVisible();
      expect(session.sends).toHaveLength(2);
      expect(session.sends[1]).toEqual({ acknowledge_recent_reply: true });
      expect(session.sends[1].acknowledge_recent_reply).toBe(true);
      await expect(page.locator('.reply-warning')).toHaveCount(0);
      await page.locator('.drawer').evaluate((el) => { el.scrollTop = 0; });
      await shoot(page, `send-anyway-${width}`);
    });

    test(`cancel leaves the draft at ${width}`, async ({ page }) => {
      await page.setViewportSize({ width, height: width === 375 ? 812 : 900 });
      const session = await boot(page, { warn: true });
      await openDraft(page);
      await page.getByRole('button', { name: 'Send it' }).click();
      const warning = page.locator('.reply-warning');
      await expect(warning).toBeVisible();
      await warning.getByRole('button', { name: 'Cancel' }).click();
      await expect(page.locator('.reply-warning')).toHaveCount(0);
      const drawer = page.getByRole('dialog', { name: 'Proposal for TEST: Wasatch Heating' });
      await expect(drawer.getByText('To review', { exact: true })).toBeVisible();
      await expect(drawer.getByRole('button', { name: 'Approve and send' })).toBeEnabled();
      expect(session.sends).toHaveLength(1);
      expect(session.sends[0].acknowledge_recent_reply).toBeUndefined();
      await page.locator('.drawer').evaluate((el) => { el.scrollTop = 0; });
      await shoot(page, `cancel-${width}`);
    });

    test(`flag off approve is unchanged at ${width}`, async ({ page }) => {
      await page.setViewportSize({ width, height: width === 375 ? 812 : 900 });
      const session = await boot(page, { warn: false });
      await openDraft(page);
      await expect(page.getByRole('button', { name: 'Send it' })).toBeVisible();
      await expect(page.locator('.reply-warning')).toHaveCount(0);
      await scrollIntoDrawer(page, '.confirm');
      await shoot(page, `flag-off-approve-${width}`);
      await page.getByRole('button', { name: 'Send it' }).click();
      const drawer = page.getByRole('dialog', { name: 'Proposal for TEST: Wasatch Heating' });
      await expect(drawer.getByText('Out', { exact: true })).toBeVisible();
      expect(session.sends).toEqual([{}]);
      await expect(page.locator('.reply-warning')).toHaveCount(0);
    });
  }
});
