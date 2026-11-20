import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DOCS = path.resolve(HERE, '../../docs/screenshots/f010-call-list');
const ARTIFACTS = '/opt/cursor/artifacts';

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

function lead(extra = {}) {
  return {
    id: 11,
    company: 'TEST: Wasatch Heating',
    industry: 'HVAC',
    city: 'Saratoga Springs',
    state: 'UT',
    address: '100 Test Street',
    contact_name: '',
    phone: '801-555-0142',
    email: 'test+owner@example.test',
    website: 'https://example.test/shop',
    rating: 4.8,
    review_count: 80,
    fit_score: 86,
    fit_tier: 'A',
    fit_boost: 0,
    fit_reasons: [{ label: 'Trade', points: 30, max: 30, detail: 'HVAC' }],
    stage: 'found',
    next_action: 'Call about after-hours booking',
    next_action_at: '2026-11-21',
    est_value: 4500,
    note: '',
    source: 'manual',
    discovered_at: '2026-11-01T15:00:00.000Z',
    activities: [],
    projects: [],
    do_not_contact: false,
    ...extra,
  };
}

const wasatch = lead();
const peak = lead({
  id: 12,
  company: 'TEST: Peak Plumbing',
  industry: 'Plumbing',
  city: 'Lehi',
  phone: '801-555-0199',
  email: 'test+peak@example.test',
  website: 'https://example.test/peak',
  fit_score: 72,
  fit_tier: 'B',
  stage: 'contacted',
  review_count: 40,
});

const focus = {
  counts: {
    proposals_to_review: 1,
    a_tier_open: 4,
    hot: 2,
    pipeline_value: 9000,
    active_projects: 1,
    proposal_replies_7d: 0,
  },
  followups_due: [peak],
  top_new_leads: [wasatch],
  gone_quiet: [],
  task_queue: [{
    id: 9,
    title: 'Kickoff call',
    project_id: 3,
    project_name: 'After-hours intake',
    client_company: 'TEST: Wasatch Heating',
    due_date: '2026-11-21',
  }],
};

async function boot(page) {
  await page.addInitScript(() => {
    const fixed = Date.parse('2026-11-20T18:00:00.000Z');
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
    if (pathname === '/api/focus') return json(route, 200, focus);
    if (pathname === '/api/proposals/jobs') return json(route, 200, { jobs: [], unreviewed: 0 });
    if (pathname === '/api/proposals/summary') return json(route, 200, { counts: {} });
    if (pathname === '/api/demo-view-tasks') return json(route, 404, { error: 'not_found' });
    if (pathname === '/api/proposals') return json(route, 200, { proposals: [] });
    if (pathname === '/api/prospects/meta') return json(route, 200, { industries: ['HVAC'], cities: ['Saratoga Springs'] });
    const prospect = pathname.match(/^\/api\/prospects\/(\d+)$/);
    if (prospect && request.method() === 'GET') {
      const row = [wasatch, peak].find((item) => String(item.id) === prospect[1]);
      return json(route, row ? 200 : 404, row || { error: 'not_found' });
    }
    return json(route, 200, {});
  });
}

async function ready(page) {
  await page.evaluate(async () => { await document.fonts.ready; });
  await page.addStyleTag({ content: '*, *::before, *::after { animation: none !important; transition: none !important; }' });
}

async function shoot(page, name) {
  await ready(page);
  const extra = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(extra).toBeLessThanOrEqual(1);
  await page.screenshot({ path: path.join(DOCS, `${name}.png`) });
  await page.screenshot({ path: path.join(ARTIFACTS, `${name}.png`) });
}

test.describe('F-010 before shots from main', () => {
  test.use({ timezoneId: 'America/Denver', locale: 'en-US', colorScheme: 'light' });
  test.beforeAll(() => {
    mkdirSync(DOCS, { recursive: true });
    mkdirSync(ARTIFACTS, { recursive: true });
  });

  for (const width of [375, 1280]) {
    test(`before Today at ${width}`, async ({ page }) => {
      await page.setViewportSize({ width, height: width === 375 ? 812 : 900 });
      await boot(page);
      await page.goto('/#/today');
      await expect(page.getByRole('heading', { name: 'Good morning, Kelby' })).toBeVisible();
      await expect(page.getByRole('heading', { name: 'Call next' })).toBeVisible();
      await expect(page.getByRole('heading', { name: 'Follow-ups due' })).toBeVisible();
      await expect(page.getByRole('button', { name: 'Open TEST: Wasatch Heating' })).toBeVisible();
      await shoot(page, `before-today-${width}`);
    });

    test(`before drawer at ${width}`, async ({ page }) => {
      await page.setViewportSize({ width, height: width === 375 ? 812 : 900 });
      await boot(page);
      await page.goto('/#/today');
      await page.getByRole('button', { name: 'Open TEST: Wasatch Heating' }).click();
      const dialog = page.getByRole('dialog', { name: 'TEST: Wasatch Heating' });
      await expect(dialog.getByRole('heading', { name: 'TEST: Wasatch Heating' })).toBeVisible();
      await expect(dialog.getByRole('link', { name: 'Call 801-555-0142' })).toBeVisible();
      await dialog.evaluate((el) => { el.scrollTop = 0; });
      await shoot(page, `before-drawer-${width}`);
    });
  }
});
