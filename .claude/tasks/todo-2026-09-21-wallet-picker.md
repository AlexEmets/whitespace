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
- [x] `src/lib/wallets.ts` — declarative registry (rdns candidates, name pattern, brand colour, install URL)
- [x] `src/hooks/useWalletOptions.ts` — derive the option list from `useConnect().connectors`
- [x] `src/components/WalletPicker.module.css` — overlay styled from the `:root` tokens
- [x] `src/components/WalletPicker.tsx` — portalled dialog, focus trap, Esc/backdrop close
- [x] `src/components/WalletConnect.tsx` — open the picker; show wallet identity when connected
- [x] `tests/unit/useWalletOptions.test.ts` — ordering, dedupe, install state, generic fallback
- [x] `tests/unit/WalletPicker.test.tsx` — renders both wallets, connects the clicked one
- [x] `tests/e2e/installMockWallet.ts` — optional EIP-6963 announce for multi-wallet e2e
- [x] Gate: `pnpm typecheck`, `pnpm test`, `pnpm build`, `pnpm e2e`

## Risks

- `com.trustwallet.app` is an assumed rdns — unverifiable without the real extension.
  Mitigated by a name-pattern fallback plus an "other detected" catch-all group, so a
  wrong guess mislabels rather than hides.
- Real extensions have never been driven in this repo
  (`docs/decisions/phase-5-frontend.md:250`). Final confirmation is manual, in a browser
  with both wallets installed.

## Review

**Changed** — 4 new source files (`lib/wallets.ts`, `hooks/useWalletOptions.ts`,
`components/WalletPicker.tsx`, `components/WalletPicker.module.css`), rewritten
`components/WalletConnect.tsx`, 25 lines added to `globals.css` for the wallet chip.
Tests: 2 new unit files (16 cases), 1 new e2e file (5 cases), plus two opt-in options on
`tests/e2e/installMockWallet.ts` (`announce`, `startsUnauthorized`) that default to the
old behaviour.

**Amendment after the first screenshot (2026-09-21)** — the picker listed MetaMask plus
five other announced wallets and put Trust under "Not installed", which exposed a flaw in
the original rule. Hiding the generic `injected()` connector whenever *anything* announced
would strand a wallet too old for EIP-6963: it announces nothing, lives only at
`window.ethereum`, and beside an announcing MetaMask it became unreachable — worse than
the `connectors[0]` bug. The rule is now provider **identity**: `useGenericInjectedInfo`
resolves `getProvider()` on the generic connector and on every announced one, and offers
the generic row only when no announced connector wraps that same object. It is labelled
from vendor flags (`describeProvider`, `isTrust` tested before `isMetaMask` because Trust
sets both) — flags label, rdns selects, never the reverse.

**Verified**
- `pnpm typecheck` — clean.
- `pnpm test` — 257 passed / 20 files.
- `pnpm build` — compiled; the `@wagmi/connectors` barrel is still untouched, so the
  `@x402/*` hazard stays avoided.
- `pnpm e2e` — the 6 new picker specs pass in Chromium, including the three that assert the
  *identity* of the connector that was used (click MetaMask → chip reads MetaMask; click
  Trust → chip reads Trust Wallet; click a non-announcing window.ethereum wallet → chip
  reads the flag-derived name).

**Not verified**
- **No real extension was ever driven.** Everything above runs against EIP-6963
  announcements this repo fabricates. `docs/decisions/phase-5-frontend.md:250` already
  records that constraint for this codebase.
- **`com.trustwallet.app` is still an assumption.** If Trust announces something else,
  it lands in the "other detected" group under its own name instead of the Trust row —
  visibly wrong, not broken. Confirm from a browser console:
  `window.addEventListener('eip6963:announceProvider', e => console.log(e.detail.info))`
  then reload, and correct `src/lib/wallets.ts` if it differs.

**Pre-existing breakage found, NOT fixed (unrelated to this work)**
`tests/e2e/trade-flow.spec.ts` fails on a clean checkout of HEAD, both cases, with
`AbiFunctionSignatureNotFoundError: "0x3acf643d"`. That selector is
`getPairPriceImpactK(uint16)`, called by `hooks/usePriceImpactLadder.ts:125` via
`DepthPanel`. The ladder landed in c8b0516 (2026-09-10); `tests/e2e/mockChain.ts`'s
PairInfos branch dates to 498eed6 (2026-09-08) and only knows `PAIR_INFOS_ABI`'s three
functions — it never learned `PAIR_INFOS_IMPACT_ABI`'s three or
`PAIR_INFOS_RISK_ABI`'s one. Confirmed by reverting all of this branch's changes and
re-running: identical failure. Fixing it means teaching `mockChain.ts` those four
functions — a separate task.

Related: `mockChain.ts:225-227` answers `eth_accounts` exactly like
`eth_requestAccounts`, so wagmi's `reconnectOnMount` connects before first paint. That is
the flake `tools/stack/drive-trade.mjs:184-186` describes. Hence `startsUnauthorized`
rather than a change to the shared mock.
