import { expect, test } from '@playwright/test';

const GALLERY = '/demo/gallery/demo-test-wasatch-heating/estimate-follow-up?flags=FF_PROTOTYPE_GALLERY&fixture=navy';

const HOSTILE = [
  'html body div.prototype-root > p.prototype-ribbon[role=note]{background:#f00 !important;background-color:#f00 !important;color:#f00 !important;-webkit-text-fill-color:#f00 !important;display:none !important;opacity:0 !important;visibility:hidden !important;border:0 !important}',
  '#root .prototype-ribbon{background:#f00 !important;background-color:#f00 !important;color:#f00 !important;-webkit-text-fill-color:#f00 !important}',
  '[role=note]{background:#fff !important;background-color:#fff !important;color:#fff !important;-webkit-text-fill-color:#fff !important}',
].join('\n');

async function ribbonBox(page) {
  return page.locator('[data-prototype-ribbon]').evaluate((el) => {
    const css = getComputedStyle(el);
    const box = el.getBoundingClientRect();
    return {
      backgroundColor: css.backgroundColor,
      color: css.color,
      fill: css.webkitTextFillColor || css.getPropertyValue('-webkit-text-fill-color'),
      opacity: css.opacity,
      visibility: css.visibility,
      display: css.display,
      width: box.width,
      height: box.height,
      borderTopWidth: css.borderTopWidth,
      borderTopStyle: css.borderTopStyle,
      borderTopColor: css.borderTopColor,
    };
  });
}

function expectVisible(box) {
  expect(box.display).not.toBe('none');
  expect(box.visibility).not.toBe('hidden');
  expect(box.opacity).toBe('1');
  expect(box.width).toBeGreaterThan(0);
  expect(box.height).toBeGreaterThan(0);
}

test('ribbon colors survive hostile !important styles on screen and in print', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(GALLERY);
  const ribbon = page.locator('[data-prototype-ribbon]');
  await expect(ribbon).toBeVisible();
  await page.addStyleTag({ content: HOSTILE });

  const screen = await ribbonBox(page);
  expect(screen.backgroundColor).toBe('rgb(30, 42, 47)');
  expect(screen.color).toBe('rgb(243, 246, 245)');
  expect(screen.fill).toBe('rgb(243, 246, 245)');
  expectVisible(screen);

  await page.emulateMedia({ media: 'print' });
  await expect.poll(() => ribbonBox(page)).toMatchObject({
    backgroundColor: 'rgb(255, 255, 255)',
    color: 'rgb(30, 42, 47)',
  });
  const printed = await ribbonBox(page);
  expect(printed.backgroundColor).toBe('rgb(255, 255, 255)');
  expect(printed.color).toBe('rgb(30, 42, 47)');
  expect(printed.fill).toBe('rgb(30, 42, 47)');
  expect(printed.borderTopWidth).toBe('2px');
  expect(printed.borderTopStyle).toBe('solid');
  expect(printed.borderTopColor).toBe('rgb(30, 42, 47)');
  expectVisible(printed);

  await page.emulateMedia({ media: 'screen' });
  await expect.poll(() => ribbonBox(page)).toMatchObject({
    backgroundColor: 'rgb(30, 42, 47)',
    color: 'rgb(243, 246, 245)',
  });
  await page.evaluate(() => window.dispatchEvent(new Event('beforeprint')));
  const before = await ribbonBox(page);
  expect(before.backgroundColor).toBe('rgb(255, 255, 255)');
  expect(before.color).toBe('rgb(30, 42, 47)');
  expect(before.borderTopWidth).toBe('2px');
  expectVisible(before);

  await page.evaluate(() => window.dispatchEvent(new Event('afterprint')));
  const after = await ribbonBox(page);
  expect(after.backgroundColor).toBe('rgb(30, 42, 47)');
  expect(after.color).toBe('rgb(243, 246, 245)');
  expectVisible(after);
});
