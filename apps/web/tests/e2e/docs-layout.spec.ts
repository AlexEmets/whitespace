import { expect, test } from '@playwright/test';
import { installMockBackend } from './mockBackend';
import { TestState } from './testState';

/**
 * The table of contents on /docs (and on /terms and /privacy, which share its layout) is
 * sticky beside the text on a wide screen. On a phone it sits above the text in one
 * column — and it stayed sticky there too: the media query that unsticks it came before
 * the rule that sticks it, so it lost, and the near-transparent panel slid over every
 * section as the page scrolled.
 */

for (const path of ['/docs', '/terms', '/privacy']) {
  test(`${path}: on a phone the contents scroll away with the page instead of covering the text`, async ({
    page,
    baseURL,
  }) => {
    await installMockBackend(page, new TestState(), `${baseURL}/__api`);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(path);

    const toc = page.getByRole('navigation', { name: 'Contents' });
    await expect(toc).toBeVisible({ timeout: 30_000 });
    expect(await toc.evaluate((el) => getComputedStyle(el).position)).toBe('static');

    await page.mouse.wheel(0, 2500);
    await expect
      .poll(async () => (await toc.boundingBox())?.y ?? 0, { timeout: 5_000 })
      .toBeLessThan(0);
  });
}

test('/docs: on a wide screen the contents stay in view beside the text', async ({ page, baseURL }) => {
  await installMockBackend(page, new TestState(), `${baseURL}/__api`);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/docs');

  const toc = page.getByRole('navigation', { name: 'Contents' });
  await expect(toc).toBeVisible({ timeout: 30_000 });
  expect(await toc.evaluate((el) => getComputedStyle(el).position)).toBe('sticky');

  await page.mouse.wheel(0, 2500);
  await expect
    .poll(async () => (await toc.boundingBox())?.y ?? -1, { timeout: 5_000 })
    .toBeGreaterThanOrEqual(0);
});
