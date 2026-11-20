import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';
import { SCOUT_COPY, callListItem, enabledCallList, walkInItem } from '../src/test/call-list-fixtures.js';

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

const callRow = callListItem();
const walkRow = walkInItem();
const thirdRow = callListItem({
  prospect_id: 43,
  company: 'TEST: Lehi Electric',
  city: 'Lehi',
  phone: '(801) 555-0160',
  tel: 'tel:8015550160',
  reason: 'Intro email 4 days ago, no reply',
  reason_code: 'intro_3_5d',
  emailed: false,
  script: SCOUT_COPY.callNeverEmailed,
  open_task_id: null,
  maps_url: 'https://www.google.com/maps/search/?api=1&query=TEST%3A%20Lehi%20Electric',
});
const listed = enabledCallList([callRow, walkRow, thirdRow]);

const task = {
  id: 7,
  prospect_id: 41,
  company: 'TEST: Wasatch Heating',
  view_count: 1,
  last_viewed_at: '2026-11-19T20:00:00.000Z',
  source: 'onepager',
  trade: 'HVAC',
  city: 'Saratoga Springs',
  phone: '(801) 555-0142',
  demo_link_expired: false,
};

async function boot(page, scene) {
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
    if (pathname === '/api/flags') {
      return json(route, 200, {
        flags: [{
          name: 'FF_CALL_LIST',
          enabled: false,
          effective: false,
          writable: true,
          source: 'db',
          env_forced_off: false,
          updated_at: null,
          updated_by: null,
        }],
      });
    }
    if (pathname === '/api/focus') {
      const body = scene === 'dedupe'
        ? { ...focus, top_new_leads: [{ ...wasatch, id: 41 }] }
        : focus;
      return json(route, 200, body);
    }
    if (pathname === '/api/proposals/jobs') return json(route, 200, { jobs: [], unreviewed: 0 });
    if (pathname === '/api/proposals/summary') return json(route, 200, { counts: {} });
    if (pathname === '/api/demo-view-tasks') {
      if (scene === 'dedupe') return json(route, 200, { tasks: [task] });
      return json(route, 404, { error: 'not_found' });
    }
    if (pathname === '/api/today/call-list') {
      if (scene === 'off') return json(route, 200, { enabled: false, items: [] });
      if (scene === 'empty') return json(route, 200, enabledCallList([]));
      if (scene === 'dedupe') return json(route, 200, enabledCallList([callRow]));
      return json(route, 200, listed);
    }
    if (pathname === '/api/proposals') return json(route, 200, { proposals: [] });
    if (pathname === '/api/prospects/meta') return json(route, 200, { industries: ['HVAC'], cities: ['Saratoga Springs'] });
    const prospect = pathname.match(/^\/api\/prospects\/(\d+)$/);
    if (prospect && request.method() === 'GET') {
      const row = [wasatch, peak].find((item) => String(item.id) === prospect[1]) || wasatch;
      const marked = scene === 'drawer'
        ? { ...row, id: Number(prospect[1]), company: 'TEST: Wasatch Heating', call_list_kind: 'call', call_list_set_at: '2026-11-20T18:00:00.000Z' }
        : { ...row, id: Number(prospect[1]) };
      return json(route, 200, marked);
    }
    return json(route, 200, {});
  });
}

async function ready(page) {
  await page.evaluate(async () => { await document.fonts.ready; });
  await page.addStyleTag({ content: '*, *::before, *::after { animation: none !important; transition: none !important; }' });
}

async function noOverflow(page) {
  const extra = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(extra).toBeLessThanOrEqual(1);
}

async function shoot(page, name) {
  await ready(page);
  await noOverflow(page);
  await page.screenshot({ path: path.join(DOCS, `${name}.png`) });
  await page.screenshot({ path: path.join(ARTIFACTS, `${name}.png`) });
}

test.describe('F-010 call list screenshots', () => {
  test.use({ timezoneId: 'America/Denver', locale: 'en-US', colorScheme: 'light' });
  test.beforeAll(() => {
    mkdirSync(DOCS, { recursive: true });
    mkdirSync(ARTIFACTS, { recursive: true });
  });

  for (const width of [375, 1280]) {
    const height = width === 375 ? 812 : 900;

    test(`list at ${width}`, async ({ page }) => {
      await page.setViewportSize({ width, height });
      await boot(page, 'list');
      await page.goto('/#/today');
      await expect(page.getByRole('heading', { name: 'Calls due / Walk-ins' })).toBeVisible();
      await expect(page.getByText(SCOUT_COPY.callEmailed)).toBeVisible();
      await expect(page.locator('.call-list-badge.is-walk')).toHaveText('Walk-in');
      await expect(page.getByRole('heading', { name: 'Call next' })).toHaveCount(0);
      const tel = page.getByRole('link', { name: 'Call TEST: Wasatch Heating' });
      await expect(tel).toHaveAttribute('href', 'tel:8015550142');
      const map = page.getByRole('link', { name: 'Map for TEST: Wasatch Heating' });
      await expect(map).toHaveAttribute('target', '_blank');
      await expect(map).toHaveAttribute('rel', 'noreferrer');
      const cards = page.locator('.call-list-card');
      await expect(cards).toHaveCount(3);
      if (width === 375) {
        const box = await tel.boundingBox();
        expect(box.height).toBeGreaterThanOrEqual(44);
        const rects = await cards.evaluateAll((els) => els.map((el) => {
          const r = el.getBoundingClientRect();
          return { height: r.height, bottom: r.bottom, top: r.top };
        }));
        for (const rect of rects) expect(rect.height).toBeLessThanOrEqual(210);
        expect(rects[2].top).toBeLessThan(height - 48);
        expect(rects[2].bottom).toBeLessThanOrEqual(height);
      }
      await page.evaluate(() => window.scrollTo(0, 0));
      await shoot(page, `list-${width}`);
    });

    test(`expanded outcomes at ${width}`, async ({ page }) => {
      await page.setViewportSize({ width, height });
      await boot(page, 'list');
      await page.goto('/#/today');
      await page.getByRole('link', { name: 'Call TEST: Wasatch Heating' }).click();
      const card = page.locator('.call-list-card').first();
      await expect(card.getByRole('button', { name: 'No answer' })).toBeVisible();
      await expect(card.getByRole('button', { name: 'Do not contact' })).toBeVisible();
      const grid = await card.getByRole('button', { name: 'No answer' }).boundingBox();
      const hold = await card.getByRole('button', { name: 'Do not contact' }).boundingBox();
      expect(hold.width).toBeGreaterThan(grid.width * 1.5);
      expect(grid.height).toBeGreaterThanOrEqual(44);
      expect(hold.height).toBeGreaterThanOrEqual(44);
      await card.scrollIntoViewIfNeeded();
      await shoot(page, `expanded-${width}`);
    });

    test(`call row at ${width}`, async ({ page }) => {
      await page.setViewportSize({ width, height });
      await boot(page, 'list');
      await page.goto('/#/today');
      const card = page.locator('.call-list-card').first();
      await expect(card.getByText(SCOUT_COPY.callEmailed)).toBeVisible();
      await card.getByRole('button', { name: 'Log TEST: Wasatch Heating' }).click();
      await card.locator('summary').click();
      await expect(card.getByText(SCOUT_COPY.voicemail)).toBeVisible();
      await expect(card.getByText(SCOUT_COPY.ask)).toBeVisible();
      await card.scrollIntoViewIfNeeded();
      await shoot(page, `call-row-${width}`);
    });

    test(`walk-in row at ${width}`, async ({ page }) => {
      await page.setViewportSize({ width, height });
      await boot(page, 'list');
      await page.goto('/#/today');
      const card = page.locator('.call-list-card').nth(1);
      await expect(card.getByText(SCOUT_COPY.walkIn)).toBeVisible();
      await expect(card.locator('.call-list-badge')).toHaveText('Walk-in');
      await expect(card.getByText(SCOUT_COPY.voicemail)).toHaveCount(0);
      await expect(card.getByRole('link', { name: /Call / })).toHaveCount(0);
      const map = card.getByRole('link', { name: 'Map for TEST: Eagle Mountain Plumbing' });
      await expect(map).toHaveClass(/is-primary/);
      await expect(map).toBeVisible();
      if (width === 375) {
        const box = await map.boundingBox();
        expect(box.height).toBeGreaterThanOrEqual(44);
      }
      await card.scrollIntoViewIfNeeded();
      await shoot(page, `walk-in-${width}`);
    });

    test(`undo at ${width}`, async ({ page }) => {
      await page.setViewportSize({ width, height });
      await boot(page, 'list');
      const posts = [];
      page.on('request', (request) => {
        if (request.method() === 'POST' && request.url().includes('/call-outcome')) posts.push(request.url());
      });
      await page.goto('/#/today');
      await page.getByRole('button', { name: 'Log TEST: Wasatch Heating' }).click();
      await page.getByRole('button', { name: 'No answer' }).click();
      const undo = page.getByRole('button', { name: 'Undo No answer (8)' });
      await expect(undo).toBeVisible();
      await expect(page.getByText('No answer. Undo to cancel.')).toBeVisible();
      const box = await undo.boundingBox();
      expect(box.y).toBeGreaterThanOrEqual(0);
      expect(box.y + box.height).toBeLessThanOrEqual(height);
      if (width === 375) expect(box.height).toBeGreaterThanOrEqual(44);
      expect(posts).toEqual([]);
      await shoot(page, `undo-${width}`);
      await undo.click();
      await expect(page.getByRole('button', { name: 'No answer' }).first()).toBeVisible();
      expect(posts).toEqual([]);
      await page.locator('.call-list-card').first().scrollIntoViewIfNeeded();
      await shoot(page, `after-undo-${width}`);
    });

    test(`empty at ${width}`, async ({ page }) => {
      await page.setViewportSize({ width, height });
      await boot(page, 'empty');
      await page.goto('/#/today');
      await expect(page.getByText('No calls due today. Add leads from a lead\'s drawer.')).toBeVisible();
      await expect(page.getByRole('heading', { name: 'Call next' })).toHaveCount(0);
      await shoot(page, `empty-${width}`);
    });

    test(`drawer at ${width}`, async ({ page }) => {
      await page.setViewportSize({ width, height });
      await boot(page, 'drawer');
      await page.goto('/#/today');
      await page.getByRole('button', { name: 'TEST: Wasatch Heating', exact: true }).click();
      const dialog = page.getByRole('dialog', { name: 'TEST: Wasatch Heating' });
      await expect(dialog.getByRole('heading', { name: 'Call list' })).toBeVisible();
      await expect(dialog.getByRole('heading', { name: 'Add to call list' })).toHaveCount(0);
      await expect(dialog.getByText('On your call list \u00B7 Call')).toBeVisible();
      await expect(dialog.getByRole('button', { name: 'Keep off call list' })).toBeVisible();
      await expect(dialog.getByText('Won\'t come back unless they view the demo')).toBeVisible();
      const keep = dialog.getByRole('button', { name: 'Keep off call list' });
      if (width === 375) {
        const box = await keep.boundingBox();
        expect(box.height).toBeGreaterThanOrEqual(44);
      }
      await dialog.locator('.call-list-marker').evaluate((el) => el.scrollIntoView({ block: 'center' }));
      await shoot(page, `drawer-${width}`);
    });

    test(`flag off today at ${width}`, async ({ page }) => {
      await page.setViewportSize({ width, height });
      await boot(page, 'off');
      await page.goto('/#/today');
      await expect(page.getByRole('heading', { name: 'Good morning, Kelby' })).toBeVisible();
      await expect(page.getByRole('heading', { name: 'Call next' })).toBeVisible();
      await expect(page.getByRole('heading', { name: 'Calls due / Walk-ins' })).toHaveCount(0);
      await shoot(page, `flag-off-today-${width}`);
    });

    test(`flag off drawer at ${width}`, async ({ page }) => {
      await page.setViewportSize({ width, height });
      await boot(page, 'off');
      await page.goto('/#/today');
      await page.getByRole('button', { name: 'Open TEST: Wasatch Heating' }).click();
      const dialog = page.getByRole('dialog', { name: 'TEST: Wasatch Heating' });
      await expect(dialog.getByRole('heading', { name: 'TEST: Wasatch Heating' })).toBeVisible();
      await expect(dialog.getByText('Add to call list')).toHaveCount(0);
      await dialog.evaluate((el) => { el.scrollTop = 0; });
      await shoot(page, `flag-off-drawer-${width}`);
    });

    test(`dedupe at ${width}`, async ({ page }) => {
      await page.setViewportSize({ width, height });
      await boot(page, 'dedupe');
      await page.goto('/#/today');
      await expect(page.getByRole('heading', { name: 'Calls due / Walk-ins' })).toBeVisible();
      await expect(page.getByText('Viewed the demo yesterday')).toBeVisible();
      await expect(page.locator('.call-list-badge')).toHaveText('Call');
      await expect(page.getByRole('heading', { name: 'Call next' })).toHaveCount(0);
      await expect(page.getByRole('heading', { name: 'Call them' })).toHaveCount(0);
      await shoot(page, `dedupe-${width}`);
    });
  }
});
