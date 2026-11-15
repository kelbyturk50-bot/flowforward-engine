import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DOCS = path.resolve(HERE, '../../docs/screenshots/f008-prospect-views');
const ARTIFACTS = '/opt/cursor/artifacts';

const LAST = '2026-11-14T21:14:00.000Z';
const SINCE = '2026-11-15T13:03:00.000Z';
const SENT = '2026-11-10T18:00:00.000Z';

function proposal(extra) {
  return {
    id: extra.id,
    prospect_id: extra.prospect_id,
    company: extra.company,
    industry: 'HVAC',
    city: extra.city,
    to_email: 'test+owner@example.test',
    to_name: 'Sam',
    subject: extra.subject,
    status: 'sent',
    fit_score: extra.fit_score,
    fit_tier: 'A',
    fit_verdict: 'strong',
    reviewed_at: '2026-11-10T17:00:00.000Z',
    version: 1,
    cost_usd: 0.12,
    feedback_rating: null,
    views: extra.views,
    last_viewed_at: LAST,
    sent_at: SENT,
    followup1_sent_at: '2026-11-13T18:00:00.000Z',
    followup2_sent_at: '2026-11-14T18:00:00.000Z',
    onepager_url: 'https://example.test/p/wasatch',
    created_at: '2026-11-10T16:00:00.000Z',
    updated_at: SENT,
    analysis: { snapshot: 'Owner-operated shop, about eight trucks.' },
    versions: [{ id: extra.id, version: 1, status: 'sent' }],
    body: 'Hi Sam — a short note about missed calls.',
    followup1: 'Checking in.',
    followup2: 'Last note.',
    prototype: null,
    ...(extra.counts || {}),
  };
}

const base = [
  {
    id: 21,
    prospect_id: 11,
    company: 'TEST: Wasatch Heating',
    city: 'Provo',
    subject: 'Missed after-hours calls',
    fit_score: 86,
    views: 9,
    counts: {
      prospect_views: 2,
      last_prospect_view_at: LAST,
      internal_views: 3,
      counting_since: SINCE,
    },
  },
  {
    id: 22,
    prospect_id: 12,
    company: 'TEST: Peak Plumbing',
    city: 'Ogden',
    subject: 'Estimate follow-up',
    fit_score: 74,
    views: 4,
    counts: {
      prospect_views: null,
      last_prospect_view_at: null,
      internal_views: null,
      counting_since: SINCE,
    },
  },
  {
    id: 23,
    prospect_id: 13,
    company: 'TEST: Bonneville Air',
    city: 'Orem',
    subject: 'Booking link',
    fit_score: 80,
    views: 3,
    counts: {
      prospect_views: 0,
      last_prospect_view_at: null,
      internal_views: 5,
      counting_since: SINCE,
    },
  },
];

function rowsFor(on) {
  return base.map((row) => proposal(on ? row : { ...row, counts: {} }));
}

const summary = {
  eligible_leads: 2,
  daily_limit: 20,
  sent_today: 1,
  spend_this_month: 0.24,
  running: false,
  setup: [],
  counts: { review: 0, out: 3, replied: 0, flagged: 0, closed: 0 },
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

function lead(row) {
  return {
    id: row.prospect_id,
    company: row.company,
    industry: 'HVAC',
    city: row.city,
    state: 'UT',
    address: '100 Test Street',
    contact_name: 'Sam Rivera',
    phone: '801-555-0142',
    email: 'test+owner@example.test',
    website: 'https://example.test/shop',
    rating: 4.8,
    review_count: 80,
    fit_score: row.fit_score,
    fit_tier: 'A',
    fit_boost: 0,
    fit_reasons: [{ label: 'Trade', points: 30, max: 30, detail: 'HVAC' }],
    stage: 'contacted',
    next_action: 'Call about the proposal',
    next_action_at: '2026-11-16',
    est_value: 4500,
    note: '',
    source: 'manual',
    discovered_at: '2026-11-01T15:00:00.000Z',
    activities: [],
    projects: [],
    do_not_contact: false,
  };
}

const cors = {
  'access-control-allow-origin': 'http://localhost:5173',
  'access-control-allow-headers': 'content-type, x-api-key',
  'access-control-allow-methods': 'GET, POST, PATCH, PUT, DELETE, OPTIONS',
};

function json(route, status, body) {
  return route.fulfill({
    status,
    contentType: 'application/json',
    headers: cors,
    body: JSON.stringify(body),
  });
}

async function boot(page, on) {
  const rows = rowsFor(on);
  await page.addInitScript(() => {
    const fixed = Date.parse('2026-11-15T18:00:00.000Z');
    const RealDate = Date;
    function FrozenDate(...args) {
      if (!new.target) return new FrozenDate().toString();
      return Reflect.construct(RealDate, args.length === 0 ? [fixed] : args, new.target);
    }
    FrozenDate.now = () => fixed;
    FrozenDate.parse = RealDate.parse;
    FrozenDate.UTC = RealDate.UTC;
    FrozenDate.prototype = RealDate.prototype;
    window.Date = FrozenDate;
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
    if (pathname === '/api/flags') return json(route, 200, { flags: [] });
    if (pathname === '/api/focus') {
      return json(route, 200, {
        counts: { proposals_to_review: 0, a_tier_open: 1, hot: 0, pipeline_value: 0, active_projects: 0, proposal_replies_7d: 0 },
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
    if (pathname === '/api/prospects/meta') return json(route, 200, { industries: ['HVAC'], cities: ['Provo'] });
    if (pathname === '/api/prospects/stats') return json(route, 200, { by_stage: [], by_tier: [] });
    if (pathname === '/api/proposals') {
      const prospectId = url.searchParams.get('prospect_id');
      if (prospectId) {
        return json(route, 200, { proposals: rows.filter((row) => String(row.prospect_id) === prospectId) });
      }
      return json(route, 200, { proposals: rows });
    }
    const detail = pathname.match(/^\/api\/proposals\/(\d+)$/);
    if (detail && request.method() === 'GET') {
      const row = rows.find((item) => String(item.id) === detail[1]);
      return json(route, row ? 200 : 404, row || { error: 'not_found' });
    }
    if (pathname === '/api/prospects') return json(route, 200, { total: 1, prospects: [lead(rows[0])] });
    const prospect = pathname.match(/^\/api\/prospects\/(\d+)$/);
    if (prospect && request.method() === 'GET') {
      const row = rows.find((item) => String(item.prospect_id) === prospect[1]);
      return json(route, row ? 200 : 404, row ? lead(row) : { error: 'not_found' });
    }
    return json(route, 200, {});
  });
}

async function ready(page) {
  await page.evaluate(async () => { await document.fonts.ready; });
}

async function noOverflow(page) {
  const extra = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(extra).toBeLessThanOrEqual(1);
}

async function placeList(page) {
  await page.locator('.prop-list').evaluate((el) => {
    const bar = document.querySelector('.mobile-bar');
    const barHeight = bar && getComputedStyle(bar).display !== 'none' ? bar.getBoundingClientRect().height : 0;
    const y = el.getBoundingClientRect().top + window.scrollY - barHeight - 8;
    window.scrollTo(0, Math.max(0, y));
  });
}

async function shoot(page, name) {
  await ready(page);
  await noOverflow(page);
  await page.screenshot({ path: path.join(DOCS, `${name}.png`) });
  await page.screenshot({ path: path.join(ARTIFACTS, `${name}.png`) });
}

test.describe('prospect vs team view screenshots', () => {
  test.use({ timezoneId: 'America/Denver', locale: 'en-US', colorScheme: 'light' });
  test.beforeAll(() => {
    mkdirSync(DOCS, { recursive: true });
    mkdirSync(ARTIFACTS, { recursive: true });
  });

  for (const width of [375, 1280]) {
    test(`tracked list at ${width}`, async ({ page }) => {
      await page.setViewportSize({ width, height: width === 375 ? 812 : 900 });
      await boot(page, true);
      await page.goto('/#/proposals?tab=out');
      await expect(page.getByText('Prospect views 2, last Nov 14, 2026, 2:14 PM MT')).toBeVisible();
      await expect(page.getByText('Team/scanner views 3')).toBeVisible();
      await expect(page.getByText('Prospect views: not tracked')).toBeVisible();
      await expect(page.getByText('counting since Nov 15, 2026, 6:03 AM MT')).toBeVisible();
      await expect(page.getByText('Prospect views 0')).toBeVisible();
      await expect(page.getByText('Team/scanner views 5')).toBeVisible();
      await expect(page.getByText(/one-pager opened/)).toHaveCount(0);
      await placeList(page);
      if (width === 375) {
        const size = await page.locator('.prospect-views-team').first().evaluate((el) => {
          const style = getComputedStyle(el);
          return {
            fontSize: parseFloat(style.fontSize),
            whiteSpace: style.whiteSpace,
            clipped: el.scrollWidth > el.clientWidth + 1,
          };
        });
        expect(size.fontSize).toBeGreaterThanOrEqual(14);
        expect(size.whiteSpace).not.toBe('nowrap');
        expect(size.clipped).toBe(false);
        const row = await page.locator('.prop-row').first().boundingBox();
        expect(row.height).toBeGreaterThanOrEqual(44);
        expect(row.width).toBeGreaterThanOrEqual(44);
      }
      const covered = await page.evaluate(() => {
        const bar = document.querySelector('.tabbar');
        const last = document.querySelectorAll('.prospect-views');
        const views = last[last.length - 1];
        if (!views || !bar || getComputedStyle(bar).display === 'none') return false;
        return views.getBoundingClientRect().bottom > bar.getBoundingClientRect().top + 1;
      });
      expect(covered).toBe(false);
      await shoot(page, `after-list-${width}`);
    });

    test(`tracked drawer at ${width}`, async ({ page }) => {
      await page.setViewportSize({ width, height: width === 375 ? 812 : 900 });
      await boot(page, true);
      await page.goto('/#/proposals?tab=out');
      await page.getByRole('button', { name: /TEST: Wasatch Heating/ }).click();
      const dialog = page.getByRole('dialog');
      const line = dialog.getByText('Prospect views 2, last Nov 14, 2026, 2:14 PM MT');
      await expect(line).toBeVisible();
      await expect(dialog.getByText('Team/scanner views 3')).toBeVisible();
      await expect(dialog.getByText(/One-pager opened/)).toHaveCount(0);
      await line.scrollIntoViewIfNeeded();
      if (width === 375) {
        const heights = await page.locator('.drawer .btn').evaluateAll((els) => els.map((el) => el.getBoundingClientRect().height));
        expect(heights.length).toBeGreaterThan(0);
        for (const height of heights) expect(height).toBeGreaterThanOrEqual(44);
      }
      await shoot(page, `after-drawer-tracked-${width}`);
    });

    test(`untracked drawer at ${width}`, async ({ page }) => {
      await page.setViewportSize({ width, height: width === 375 ? 812 : 900 });
      await boot(page, true);
      await page.goto('/#/proposals?tab=out');
      await page.getByRole('button', { name: /TEST: Peak Plumbing/ }).click();
      const dialog = page.getByRole('dialog');
      const line = dialog.getByText('Prospect views: not tracked');
      await expect(line).toBeVisible();
      await expect(dialog.getByText('counting since Nov 15, 2026, 6:03 AM MT')).toBeVisible();
      await expect(dialog.getByText(/Team\/scanner/)).toHaveCount(0);
      await line.scrollIntoViewIfNeeded();
      await shoot(page, `after-drawer-untracked-${width}`);
    });

    test(`team-only drawer at ${width}`, async ({ page }) => {
      await page.setViewportSize({ width, height: width === 375 ? 812 : 900 });
      await boot(page, true);
      await page.goto('/#/proposals?tab=out');
      await page.getByRole('button', { name: /TEST: Bonneville Air/ }).click();
      const dialog = page.getByRole('dialog');
      const line = dialog.getByText('Prospect views 0', { exact: true });
      await expect(line).toBeVisible();
      await expect(dialog.getByText('Team/scanner views 5')).toBeVisible();
      await expect(dialog.getByText(/last Nov/)).toHaveCount(0);
      await line.scrollIntoViewIfNeeded();
      await shoot(page, `after-drawer-team-${width}`);
    });

    test(`lead at ${width}`, async ({ page }) => {
      await page.setViewportSize({ width, height: width === 375 ? 812 : 900 });
      await boot(page, true);
      await page.goto('/#/leads');
      await page.getByText('TEST: Wasatch Heating', { exact: true }).first().click();
      const line = page.getByText('Prospect views 2, last Nov 14, 2026, 2:14 PM MT');
      const team = page.getByText('Team/scanner views 3');
      await expect(line).toBeVisible();
      await expect(team).toBeVisible();
      await page.locator('.drawer .prospect-views').evaluate((el) => {
        el.scrollIntoView({ block: 'center', inline: 'nearest' });
      });
      if (width === 375) {
        const open = page.getByRole('button', { name: 'Open' });
        const box = await open.boundingBox();
        expect(box.height).toBeGreaterThanOrEqual(44);
        expect(box.width).toBeGreaterThanOrEqual(44);
      }
      await shoot(page, `after-lead-${width}`);
    });

    test(`flag off list at ${width}`, async ({ page }) => {
      await page.setViewportSize({ width, height: width === 375 ? 812 : 900 });
      await boot(page, false);
      await page.goto('/#/proposals?tab=out');
      await expect(page.getByText('one-pager opened 9×')).toBeVisible();
      await expect(page.getByText('one-pager opened 4×')).toBeVisible();
      await expect(page.getByText('one-pager opened 3×')).toBeVisible();
      await expect(page.getByText(/Prospect views/)).toHaveCount(0);
      await expect(page.getByText(/Team\/scanner/)).toHaveCount(0);
      await expect(page.getByText(/not tracked/)).toHaveCount(0);
      await placeList(page);
      await shoot(page, `after-flag-off-list-${width}`);
    });

    test(`flag off drawer at ${width}`, async ({ page }) => {
      await page.setViewportSize({ width, height: width === 375 ? 812 : 900 });
      await boot(page, false);
      await page.goto('/#/proposals?tab=out');
      await page.getByRole('button', { name: /TEST: Wasatch Heating/ }).click();
      const dialog = page.getByRole('dialog');
      const line = dialog.getByText(/One-pager opened 9×, last 20h ago/);
      await expect(line).toBeVisible();
      await expect(dialog.getByText(/Prospect views/)).toHaveCount(0);
      await line.scrollIntoViewIfNeeded();
      await shoot(page, `after-flag-off-drawer-${width}`);
    });

    test(`flag off lead at ${width}`, async ({ page }) => {
      await page.setViewportSize({ width, height: width === 375 ? 812 : 900 });
      await boot(page, false);
      await page.goto('/#/leads');
      await page.getByText('TEST: Wasatch Heating', { exact: true }).first().click();
      await expect(page.getByRole('heading', { name: 'Proposal' })).toBeVisible();
      await expect(page.getByText(/sent 5d ago/)).toBeVisible();
      await expect(page.getByText(/Prospect views/)).toHaveCount(0);
      await expect(page.getByText(/one-pager opened/)).toHaveCount(0);
      await page.getByRole('heading', { name: 'Proposal' }).scrollIntoViewIfNeeded();
      await shoot(page, `after-flag-off-lead-${width}`);
    });
  }
});
