import { expect, test } from '@playwright/test';
import { installMockBackend } from './mockBackend';
import { installMockWallet } from './installMockWallet';
import { TestState } from './testState';

/**
 * On a desktop /vaults the vault panel and the lifecycle explainer are two halves of one
 * row, so they have to end on the same line. The grid used to size each to its own
 * content, and whichever was shorter stopped short of its neighbour.
 *
 * Layout only exists in a real browser, which is why this is an e2e check. Two widths,
 * because which panel is the taller one flips as the explainer's text rewraps.
 */
for (const width of [1100, 1440]) {
  test(`the vault panel and the lifecycle explainer share a top and a bottom at ${width}px`, async ({ page, baseURL }) => {
    await page.setViewportSize({ width, height: 900 });
    const state = new TestState();
    await installMockWallet(page, state);
    await installMockBackend(page, state, `${baseURL}/__api`);

    await page.goto('/vaults');
    await page.getByTestId('connect-wallet-button').click();
    // Connected: the panel's tallest state, with shares, balance and both buttons.
    await expect(page.getByTestId('vault-shares')).toBeVisible();

    const panel = await page.getByTestId('vault-panel').boundingBox();
    const lifecycle = await page.getByTestId('vault-lifecycle').boundingBox();
    expect(panel).not.toBeNull();
    expect(lifecycle).not.toBeNull();

    expect(Math.abs(panel!.y - lifecycle!.y)).toBeLessThan(1);
    expect(Math.abs(panel!.y + panel!.height - (lifecycle!.y + lifecycle!.height))).toBeLessThan(1);
  });
}
