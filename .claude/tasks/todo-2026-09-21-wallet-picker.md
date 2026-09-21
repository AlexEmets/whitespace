# Wallet picker — let the trader choose MetaMask vs Trust

## Problem

`WalletConnect.tsx:25` does `const connector = connectors[0]`. wagmi's `createConfig`
puts the configured `injected()` connector at index 0 and appends every EIP-6963
provider after it (`@wagmi/core/createConfig.js:222-242`, `multiInjectedProviderDiscovery`
defaults to `true`). The generic `injected()` connector resolves `window.ethereum`, which
is whichever extension won the injection race — Trust, on the reporting machine. MetaMask
is already in `connectors`; the UI just never offers it.

## Why not the obvious alternatives

- `injected({ target: 'metaMask' })` — `targetMap.metaMask` (`injected.js:471`) rejects a
  blocklist of `isXxx` flags that does **not** include `isTrust`, and Trust sets
  `isMetaMask: true`. It would return Trust. There is also no `trust` target at all;
  `targetMap` holds only `coinbaseWallet`, `metaMask`, `phantom`.
- `metaMask()` from `wagmi/connectors` — that barrel breaks `next build` (Coinbase
  `cdp-sdk` → unpublished `@x402/*`), per `wagmiConfig.ts:2-8` and
  `docs/decisions/phase-5-frontend.md:44-49`.

Match on EIP-6963 `rdns` instead: `providerDetailToConnector` (`createConfig.js:64-68`)
builds each discovered connector as `injected({ target: { ...info, id: info.rdns, provider } })`,
so `connector.id` **is** the rdns and `connector.icon` is the wallet's own data-URI logo.

## Decisions (locked)

- Modal from the existing header Connect button, not a `/connect` route.
- Injected wallets only. No WalletConnect, no new dependencies.
- MetaMask and Trust always listed; when not announced they render disabled with an
  `Install ↗` link.
- Detected wallets show their real EIP-6963 logo. Not-installed ones show a brand-coloured
  monogram tile. The icon itself therefore encodes installed-vs-not.
- **Single-option fast path**: exactly one connectable option → the Connect button
  connects directly, no modal. Keeps `trade-flow.spec.ts` and `drive-trade.mjs` on one
  click.

## Steps

- [x] Map the current wiring and confirm the root cause in wagmi's source
- [] `src/lib/wallets.ts` — declarative registry (rdns candidates, name pattern, brand colour, install URL)
- [ ] `src/hooks/useWalletOptions.ts` — derive the option list from `useConnect().connectors`
- [ ] `src/components/WalletPicker.module.css` — overlay styled from the `:root` tokens
- [ ] `src/components/WalletPicker.tsx` — portalled dialog, focus trap, Esc/backdrop close
- [ ] `src/components/WalletConnect.tsx` — open the picker; show wallet identity when connected
- [ ] `tests/unit/useWalletOptions.test.ts` — ordering, dedupe, install state, generic fallback
- [ ] `tests/unit/WalletPicker.test.tsx` — renders both wallets, connects the clicked one
- [ ] `tests/e2e/installMockWallet.ts` — optional EIP-6963 announce for multi-wallet e2e
- [ ] Gate: `pnpm typecheck`, `pnpm test`, `pnpm build`, `pnpm e2e`

## Risks

- `com.trustwallet.app` is an assumed rdns — unverifiable without the real extension.
  Mitigated by a name-pattern fallback plus an "other detected" catch-all group, so a
  wrong guess mislabels rather than hides.
- Real extensions have never been driven in this repo
  (`docs/decisions/phase-5-frontend.md:250`). Final confirmation is manual, in a browser
  with both wallets installed.

## Review

(filled in when the work lands)
