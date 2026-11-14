import { mkdirSync } from 'node:fs';
import { expect, test } from '@playwright/test';

const OUT = '/opt/cursor/artifacts';

const focus = {
  counts: {
    proposals_to_review: 1,
    a_tier_open: 3,
    hot: 2,
    pipeline_value: 9000,
    active_projects: 1,
    proposal_replies_7d: 0,
  },
  followups_due: [{
    id: 31,
    company: 'TEST: Ridge Electric',
    industry: 'Electrical',
    city: 'Orem',
    phone: '(801) 555-0170',
    rating: 4.6,
    review_count: 40,
    fit_score: 80,
    fit_tier: 'A',
    stage: 'contacted',
    next_action: 'Follow up',
    next_action_at: '2026-11-14',
  }],
  top_new_leads: [{
    id: 32,
    company: 'TEST: Canyon HVAC',
    industry: 'HVAC',
    city: 'Provo',
    phone: '(801) 555-0160',
    rating: 4.9,
    review_count: 80,
    fit_score: 88,
    fit_tier: 'A',
    stage: 'found',
  }],
  gone_quiet: [],
  task_queue: [{
    id: 9,
    title: 'Kickoff call',
    project_id: 3,
    project_name: 'TEST: After-hours intake',
    client_company: 'TEST: Canyon HVAC',
    due_date: '2026-11-16',
  }],
};

const withPhone = {
  id: 1,
  prospect_id: 10,
  proposal_id: 20,
  company: 'TEST: Wasatch Heating',
  view_count: 2,
  last_viewed_at: '2026-11-14T21:14:00.000Z',
  source: 'onepager',
  trade: 'HVAC',
  city: 'Provo',
  phone: '(801) 555-0142',
  demo_link_expired: false,
};

const noPhone = {
  id: 2,
  prospect_id: 12,
  proposal_id: 21,
  company: 'TEST: Bonneville Plumbing',
  view_count: 1,
  last_viewed_at: '2026-11-14T21:14:00.000Z',
  source: 'demo',
  trade: 'Plumbing',
  city: 'Ogden',
  phone: null,
  demo_link_expired: false,
};

const cors = {
  'access-control-allow-origin': 'http://localhost:5173',
  'access-control-allow-headers': 'content-type, x-api-key',
  'access-control-allow-methods': 'GET, POST, OPTIONS',
};

function json(route, status, body) {
  return route.fulfill({
    status,
    contentType: 'application/json',
    headers: cors,
    body: JSON.stringify(body),
  });
}

async function boot(page, { tasks = [], missing = false } = {}) {
  const noise = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error' || msg.type() === 'warning') noise.push(msg.text());
  });
  page.on('pageerror', (err) => noise.push(err.message));
  await page.addInitScript(() => {
    const fixed = Date.parse('2026-11-14T18:00:00.000Z');
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
  });
  await page.route('http://localhost:3000/**', async (route) => {
    const request = route.request();
    if (request.method() === 'OPTIONS') {
      await route.fulfill({ status: 204, headers: cors });
      return;
    }
    const { pathname } = new URL(request.url());
    if (pathname === '/api/demo-view-tasks' && request.method() === 'GET') {
      if (missing) {
        await json(route, 404, { error: 'not_found' });
        return;
      }
      await json(route, 200, { tasks });
      return;
    }
    if (request.method() === 'POST' && /\/api\/demo-view-tasks\/\d+\/snooze$/.test(pathname)) {
      await json(route, 200, { id: 1, status: 'open', snoozed_until: '2026-11-15T21:14:00.000Z' });
      return;
    }
    if (pathname === '/api/focus') {
      await json(route, 200, focus);
      return;
    }
    if (pathname === '/api/flags') {
      await json(route, 200, { flags: [] });
      return;
    }
    if (pathname === '/api/proposals/jobs') {
      await json(route, 200, { jobs: [], unreviewed: 0 });
      return;
    }
    await json(route, 404, { error: 'not_found' });
  });
  await page.goto('/#/today');
  await expect(page.getByRole('heading', { name: /Good morning, Kelby/ })).toBeVisible();
  await page.evaluate(async () => {
    await document.fonts.ready;
    const loaded = [...document.fonts].some((font) => font.family === 'Barlow' && font.status === 'loaded');
    if (!loaded) throw new Error('Barlow did not load');
  });
  return noise;
}

function ignoreBrowserNoise(lines) {
  // Chromium logs a failed resource for the flag-off 404. The app does not
  // call console.error or console.warn for that response.
  return lines.filter((line) => !/favicon|\[vite\]|Download the React DevTools|Failed to load resource: the server responded with a status of 404/i.test(line));
}

async function expectNoHorizontalScroll(page) {
  const extra = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(extra).toBeLessThanOrEqual(1);
}

async function expectCardNotCovered(page) {
  const details = await page.evaluate(() => {
    const card = document.querySelector('.view-task-panel');
    const actions = [...document.querySelectorAll('.view-task-actions .btn')];
    const targets = actions.length ? actions : [...document.querySelectorAll('.view-task')];
    const blockers = [...document.querySelectorAll('.tabbar, .toast.show')].filter((el) => {
      const style = getComputedStyle(el);
      const box = el.getBoundingClientRect();
      return style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity) !== 0 && box.width > 1 && box.height > 1;
    });
    const hits = [];
    for (const target of targets) {
      const box = target.getBoundingClientRect();
      for (const el of blockers) {
        const other = el.getBoundingClientRect();
        const overlap = !(box.right <= other.left || box.left >= other.right || box.bottom <= other.top || box.top >= other.bottom);
        if (overlap) hits.push({
          target: target.innerText.slice(0, 40),
          targetBottom: Math.round(box.bottom),
          blocker: el.className,
          blockerTop: Math.round(other.top),
        });
      }
    }
    return {
      hits,
      panel: card ? Math.round(card.getBoundingClientRect().bottom) : null,
      viewport: window.innerHeight,
    };
  });
  expect(details.hits, JSON.stringify(details)).toEqual([]);
}

async function shoot(page, name) {
  await page.evaluate(() => {
    const actions = document.querySelector('.view-task-actions') || document.querySelector('.view-task');
    const bar = document.querySelector('.tabbar');
    if (!actions) return;
    const barTop = bar && getComputedStyle(bar).display !== 'none'
      ? bar.getBoundingClientRect().top
      : window.innerHeight;
    const bottom = actions.getBoundingClientRect().bottom;
    if (bottom > barTop - 12) window.scrollBy(0, bottom - (barTop - 12));
  });
  await expectCardNotCovered(page);
  await page.evaluate(() => {
    const toast = document.querySelector('.toast');
    if (toast) toast.style.display = 'none';
  });
  await page.screenshot({ path: `${OUT}/${name}.png`, fullPage: false });
}

async function expectTapTargets(page) {
  const boxes = await page.locator('.view-task-actions .btn').evaluateAll((els) => els.map((el) => {
    const box = el.getBoundingClientRect();
    return {
      height: box.height,
      width: box.width,
      whiteSpace: getComputedStyle(el).whiteSpace,
    };
  }));
  expect(boxes.length).toBeGreaterThan(0);
  for (const box of boxes) {
    expect(box.height).toBeGreaterThanOrEqual(44);
    expect(box.width).toBeGreaterThanOrEqual(44);
    expect(box.whiteSpace).not.toBe('nowrap');
  }
}

async function expectTitleWraps(page) {
  const clipped = await page.locator('.view-task-title').first().evaluate((el) => {
    const style = getComputedStyle(el);
    return style.textOverflow === 'ellipsis'
      || style.whiteSpace === 'nowrap'
      || el.scrollWidth > el.clientWidth + 1;
  });
  expect(clipped).toBe(false);
}

test.describe('Today demo-view call tasks', () => {
  test.use({
    timezoneId: 'America/Denver',
    locale: 'en-US',
    colorScheme: 'light',
  });

  test.beforeAll(() => {
    mkdirSync(OUT, { recursive: true });
  });

  for (const width of [375, 1280]) {
    test(`task present at ${width}`, async ({ page }) => {
      await page.setViewportSize({ width, height: width === 375 ? 812 : 900 });
      const noise = await boot(page, { tasks: [withPhone] });
      await expect(page.getByRole('heading', { name: 'Call them' })).toBeVisible();
      await expect(page.getByText('Call TEST: Wasatch Heating: viewed your proposal 2 times')).toBeVisible();
      await expect(page.getByText('today 2:14 PM · proposal · HVAC · Provo')).toBeVisible();
      await expect(page.getByRole('link', { name: 'Call TEST: Wasatch Heating at (801) 555-0142' })).toHaveAttribute('href', 'tel:8015550142');
      await expectTapTargets(page);
      await expectTitleWraps(page);
      await expectNoHorizontalScroll(page);
      const font = await page.locator('.view-task-title').evaluate((el) => getComputedStyle(el).fontFamily);
      expect(font.toLowerCase()).toContain('barlow');
      await shoot(page, `today-task-${width}`);
      expect(ignoreBrowserNoise(noise)).toEqual([]);
    });

    test(`no phone at ${width}`, async ({ page }) => {
      await page.setViewportSize({ width, height: width === 375 ? 812 : 900 });
      const noise = await boot(page, { tasks: [noPhone] });
      await expect(page.getByText('Call TEST: Bonneville Plumbing: viewed your proposal 1 time')).toBeVisible();
      await expect(page.getByText('today 2:14 PM · live demo · Plumbing · Ogden')).toBeVisible();
      await expect(page.getByText('No phone on file')).toBeVisible();
      await expect(page.getByRole('button', { name: 'Open TEST: Bonneville Plumbing' })).toBeVisible();
      await expect(page.locator('.view-task-panel').getByRole('link', { name: /Call / })).toHaveCount(0);
      await expectTapTargets(page);
      await expectTitleWraps(page);
      await expectNoHorizontalScroll(page);
      await shoot(page, `today-nophone-${width}`);
      expect(ignoreBrowserNoise(noise)).toEqual([]);
    });

    test(`snoozed at ${width}`, async ({ page }) => {
      await page.setViewportSize({ width, height: width === 375 ? 812 : 900 });
      const noise = await boot(page, { tasks: [withPhone] });
      await page.getByRole('button', { name: 'Snooze TEST: Wasatch Heating for 1 day' }).click();
      await expect(page.getByText('Snoozed until tomorrow 2:14 PM', { exact: true })).toBeVisible();
      await expect(page.getByRole('link', { name: /Call TEST: Wasatch Heating/ })).toHaveCount(0);
      await expect(page.getByRole('button', { name: 'Done, TEST: Wasatch Heating' })).toHaveCount(0);
      await expectNoHorizontalScroll(page);
      await shoot(page, `today-snoozed-${width}`);
      expect(ignoreBrowserNoise(noise)).toEqual([]);
    });

    test(`flag off at ${width}`, async ({ page }) => {
      await page.setViewportSize({ width, height: width === 375 ? 812 : 900 });
      const noise = await boot(page, { missing: true });
      await expect(page.getByRole('heading', { name: 'Follow-ups due' })).toBeVisible();
      await expect(page.getByRole('heading', { name: 'Call next' })).toBeVisible();
      await expect(page.getByText('TEST: Ridge Electric')).toBeVisible();
      await expect(page.getByRole('heading', { name: 'Call them' })).toHaveCount(0);
      await expect(page.getByText('not_found')).toHaveCount(0);
      await expect(page.getByRole('alert')).toHaveCount(0);
      await expectNoHorizontalScroll(page);
      await page.screenshot({ path: `${OUT}/today-flag-off-${width}.png`, fullPage: false });
      expect(ignoreBrowserNoise(noise)).toEqual([]);
    });
  }
});
