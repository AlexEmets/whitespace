import { expect, test } from '@playwright/test';
import { installMockBackend } from './mockBackend';
import { installMockWallet } from './installMockWallet';
import { MOCK_TRADER_ADDRESS, TestState } from './testState';

/**
 * The bug: with MetaMask and Trust both installed, the app connected `connectors[0]` —
 * wagmi's untargeted `injected()` connector, i.e. whoever won the race for
 * `window.ethereum`. MetaMask was already discovered over EIP-6963 and sitting in the
 * same array, just never offered.
 *
 * This drives the real browser with two announced wallets, which is the only place the
 * mipd discovery path actually runs. The unit tests cover the derivation rules; this
 * covers the wiring — announcement to connector to click to connected identity.
 *
 * Driven from the landing page rather than /trade: the picker lives in NavHeader, which
 * layout.tsx mounts on every route, and /trade additionally renders DepthPanel, whose
 * price-impact ladder calls `getPairPriceImpactK` — a selector tests/e2e/mockChain.ts has
 * never known (the ladder landed in c8b0516, the mock's PairInfos branch dates to
 * 498eed6). That gap already fails trade-flow.spec.ts on a clean checkout and is not this
 * suite's business.
 */

const METAMASK = { uuid: '11111111-1111-4111-8111-111111111111', name: 'MetaMask', rdns: 'io.metamask' };
const TRUST = { uuid: '22222222-2222-4222-8222-222222222222', name: 'Trust Wallet', rdns: 'com.trustwallet.app' };
const RABBY = { uuid: '33333333-3333-4333-8333-333333333333', name: 'Rabby Wallet', rdns: 'io.rabby' };

const SHORT_ADDRESS = `${MOCK_TRADER_ADDRESS.slice(0, 6)}…${MOCK_TRADER_ADDRESS.slice(-4)}`;

test('offers both wallets and connects the one the trader picks', async ({ page, baseURL }) => {
  const state = new TestState();
  await installMockWallet(page, state, { announce: [METAMASK, TRUST], startsUnauthorized: true });
  await installMockBackend(page, state, `${baseURL}/__api`);

  await page.goto('/');

  await page.getByTestId('connect-wallet-button').click();

  const picker = page.getByTestId('wallet-picker');
  await expect(picker).toBeVisible();
  await expect(page.getByTestId('wallet-option-metamask')).toBeVisible();
  await expect(page.getByTestId('wallet-option-trust')).toBeVisible();
  // The generic connector must not be listed next to them: it duplicates whichever of
  // the two owns window.ethereum, and picking it is the original bug.
  await expect(page.getByTestId('wallet-option-injected')).toHaveCount(0);

  await page.getByTestId('wallet-option-metamask').click();

  await expect(picker).not.toBeVisible();
  await expect(page.getByTestId('wallet-connected')).toBeVisible();
  await expect(page.getByTestId('wallet-address')).toHaveText(SHORT_ADDRESS);
  // wagmi reports the connector it actually used, so this is the assertion that proves
  // the click chose MetaMask rather than falling through to window.ethereum.
  await expect(page.getByTestId('wallet-connected')).toContainText('MetaMask');
});

test('connects Trust when Trust is the row that was clicked', async ({ page, baseURL }) => {
  const state = new TestState();
  await installMockWallet(page, state, { announce: [METAMASK, TRUST], startsUnauthorized: true });
  await installMockBackend(page, state, `${baseURL}/__api`);

  await page.goto('/');
  await page.getByTestId('connect-wallet-button').click();
  await page.getByTestId('wallet-option-trust').click();

  await expect(page.getByTestId('wallet-connected')).toContainText('Trust Wallet');
});

test('closes on Escape without connecting', async ({ page, baseURL }) => {
  const state = new TestState();
  await installMockWallet(page, state, { announce: [METAMASK, TRUST], startsUnauthorized: true });
  await installMockBackend(page, state, `${baseURL}/__api`);

  await page.goto('/');
  await page.getByTestId('connect-wallet-button').click();
  await expect(page.getByTestId('wallet-picker')).toBeVisible();

  await page.keyboard.press('Escape');

  await expect(page.getByTestId('wallet-picker')).not.toBeVisible();
  await expect(page.getByTestId('wallet-connected')).toHaveCount(0);
  await expect(page.getByTestId('connect-wallet-button')).toBeFocused();
});

test('lists an unknown wallet and still links Trust to its download page', async ({ page, baseURL }) => {
  const state = new TestState();
  // Two announced wallets so the dialog opens at all, neither of them Trust.
  await installMockWallet(page, state, { announce: [METAMASK, RABBY], startsUnauthorized: true });
  await installMockBackend(page, state, `${baseURL}/__api`);

  await page.goto('/');
  await page.getByTestId('connect-wallet-button').click();

  await expect(page.getByTestId('wallet-option-metamask')).toBeVisible();
  await expect(page.getByTestId(`wallet-option-rdns:${RABBY.rdns}`)).toBeVisible();
  await expect(page.getByTestId('wallet-option-trust')).toHaveCount(0);
  await expect(page.getByTestId('wallet-install-trust')).toHaveAttribute(
    'href',
    'https://trustwallet.com/download',
  );
});

/**
 * A wallet too old for EIP-6963 announces nothing and lives only at `window.ethereum`.
 * Beside a newer MetaMask that does announce, the naive rule "hide the generic connector
 * whenever anything announced" would strand it — unreachable, which is worse than the
 * connectors[0] bug this picker replaced. The rule is provider identity instead.
 */
test('reaches a wallet that owns window.ethereum but announces nothing', async ({ page, baseURL }) => {
  const state = new TestState();
  await installMockWallet(page, state, {
    announce: [METAMASK],
    silentWallet: { flag: 'isTrust' },
    startsUnauthorized: true,
  });
  await installMockBackend(page, state, `${baseURL}/__api`);

  await page.goto('/');
  await page.getByTestId('connect-wallet-button').click();

  const silent = page.getByTestId('wallet-option-injected');
  await expect(silent).toBeVisible();
  // Named from its vendor flag, since there is no rdns to match on.
  await expect(silent).toContainText('Trust Wallet');

  await silent.click();

  await expect(page.getByTestId('wallet-connected')).toBeVisible();
  await expect(page.getByTestId('wallet-connected')).toContainText('Trust Wallet');
});

test('skips the dialog when only one wallet is present', async ({ page, baseURL }) => {
  const state = new TestState();
  await installMockWallet(page, state, { announce: [METAMASK], startsUnauthorized: true });
  await installMockBackend(page, state, `${baseURL}/__api`);

  await page.goto('/');
  await page.getByTestId('connect-wallet-button').click();

  // One wallet is no choice at all, so Connect goes straight to it. This is also what
  // keeps trade-flow.spec.ts a single click.
  await expect(page.getByTestId('wallet-connected')).toBeVisible();
  await expect(page.getByTestId('wallet-picker')).toHaveCount(0);
});
