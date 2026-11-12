# @whitespace/web

The Whitespace trading terminal: a Next.js 15 (App Router) app on React 18, wagmi 2 and viem 2.
It trades on Whitechain testnet **1874**, reads live state from the chain and from
[`services/api`](../../services/api), and signs every write in the trader's own wallet or in a
browser-held session key.

```bash
pnpm install                              # from the repo root
cp apps/web/.env.example apps/web/.env.local
pnpm --filter @whitespace/web dev         # http://localhost:3000
```

## Routes

All routes live in [`src/app`](src/app).

| Route | What it is |
|---|---|
| `/` | Landing page. Every figure on it is read live: max leverage from `/markets`, taker/maker fee and oracle quorum from chain, and the vault's two-sided quote for 10,000 USDW |
| `/trade` | The terminal: markets rail with the account card, market header, price chart, tabbed account tables (positions, orders, history) and the order ticket. There is no order book; the ticket shows the vault's quote for the size being typed |
| `/portfolio` | Cross-market account view: account value, open positions, unrealised and realised PnL, the USDW wallet balance and the LP vault position |
| `/vaults` | The LP vault: TVL, the trader's share, deposit/withdraw and the settlement lifecycle |
| `/faucet` | Testnet USDW (`USDW.claim()`, 1,000 per 24 h) and native WBT for gas (via the API's `POST /faucet/wbt`) |
| `/points` | Season One points, leaderboard, and the connected wallet's Hunter bug-bounty badges |
| `/docs` | How the protocol works; chain-readable parameters are read, not transcribed |
| `/docs/api` | Reference for the public read API (REST + WebSocket) |
| `/terms`, `/privacy` | Legal pages. A connected wallet must accept the Terms (once per browser per Terms version) before anything else; declining disconnects it |
| `/share/:address/:id` | Share page for one trade's PnL card, rendered server-side for X/Telegram previews |
| `/share/:address/:id/card.png` | The PnL card as a PNG (`next/og` `ImageResponse`) |
| `/share/:address/stats` | Share page for a wallet's trading stats |
| `/share/:address/stats/card.png` | The stats card as a PNG |

The `share` routes are `force-dynamic` and fetch everything they render from the API on the
server; only the address, id and theme (`?t=`) come from the URL.

## Architecture

```
src/app/         routes (above)
src/components/  UI: terminal/, portfolio/, points/, share/, docs/, legal/, dialogs, panels
src/hooks/       one hook per piece of state (usePositions, useQuote, useVault, useSessionKey, ...)
src/lib/         pure logic: config, ABIs, money/price maths, quote and impact, order rules, API + WS clients
```

### Where data comes from

| Source | Used for | Code |
|---|---|---|
| **Chain** (wagmi `useReadContract(s)` over viem `http()`) | Quotes and price impact, fees, funding, liquidation price, open trades from `TradingStorage`, pending orders, USDW/WBT balances and allowance, vault state, oracle quorum, session-key delegate, Hunter badges | `useQuote`, `useMarketFees`, `useFundingRate`, `useLiquidationPrice`, `useChainPendingOrders`, `useErc20`, `useVault`, `useProtocolParams`, ... |
| **REST** (`NEXT_PUBLIC_API_BASE_URL`) | Markets, prices and venue health, candles, positions and history, orders and order history, fees, PnL, points and leaderboard, WBT faucet | [`src/lib/api.ts`](src/lib/api.ts) |
| **WebSocket** (`NEXT_PUBLIC_WS_URL`) | Live updates on `price:<pairIndex>`, `positions:<address>`, `orders:<address>`, `candles:<pairIndex>:<interval>` | [`src/lib/ws.ts`](src/lib/ws.ts) |

Live resources go through [`useLiveResource`](src/hooks/useLiveResource.ts): an initial REST
fetch, a REST poll that keeps running (5 s by default), and a WebSocket subscription that
only makes updates arrive sooner. The socket is never required; the app is correct if it
never connects.

Open positions are read from chain, not from the indexer: `usePositions` scans `TradingStorage`
for every pair the live `/markets` list reports (the manifest's markets before that loads) and
uses the API's list only if those reads fail, so a lagging indexer cannot hide or resurrect a
position.

When a market's healthy venue count falls below its minimum, `DegradedBanner` says so and the
order ticket disables opens. Closes stay available.

### Contract addresses

[`src/lib/deployment.ts`](src/lib/deployment.ts) imports the repo-root
[`deployments/1874.json`](../../deployments/1874.json) at build time. That file is the **only**
address source: there are no address env vars. It is generated from the chain's registry by
`tools/deploy/manifest.mjs` after a deploy (see
[`docs/runbooks/redeploy-testnet-1874.md`](../../docs/runbooks/redeploy-testnet-1874.md)). A
redeploy therefore needs a regenerated manifest **and** a rebuild of this app.

The chain itself is defined in [`src/lib/chain.ts`](src/lib/chain.ts) from
`@whitespace/shared/chains`. `CHAIN_ID` is fixed to `1874` in
[`src/lib/config.ts`](src/lib/config.ts). Mainnet 1875 is registered in the wagmi config only
so the Hunter badge reads have a transport; the wallet is never switched to it.

### Wallets

[`src/lib/wagmiConfig.ts`](src/lib/wagmiConfig.ts) uses wagmi's single `injected()` connector
(MetaMask-style wallets); `wagmi/connectors` is deliberately not imported. Every write first
makes sure the wallet is on 1874 and offers to add the network if it has never seen it
(`useChainGuard`, `useTestnetWriteContract`).

### One-click trading (session keys)

[`src/lib/sessionKey.ts`](src/lib/sessionKey.ts) and
[`src/hooks/useSessionKey.ts`](src/hooks/useSessionKey.ts):

1. The browser generates a fresh EOA and stores its private key in `localStorage` under
   `whitespace:1ct:<chainId>:<trader>`.
2. The trader registers it on chain with `WhitespaceTrading.setDelegate(sessionAddress)` (one
   wallet signature) and tops it up with 0.05 WBT for gas.
3. From then on, trades are signed locally and sent as `delegatedAction(trader, calldata)`,
   which the contract executes as the trader. No wallet pop-up.

The delegate can only trade: payouts and refunds go to the trader, and the delegation
management selectors are forbidden inside `delegatedAction`. Trades fall back to the wallet
until the key is both registered and holding gas; the terminal warns when its balance falls
below 0.005 WBT. `removeDelegate`
revokes it on chain and wipes the stored key.

## Configuration

Copy [`.env.example`](.env.example) to `.env.local`. All `NEXT_PUBLIC_*` values are inlined at
build time, so changing one needs a rebuild.

| Variable | Default | Purpose |
|---|---|---|
| `NEXT_PUBLIC_API_BASE_URL` | `http://localhost:4000` | Base URL of `services/api` |
| `NEXT_PUBLIC_WS_URL` | `ws://localhost:4000/ws` | API WebSocket endpoint |
| `NEXT_PUBLIC_RPC_URL` | public 1874 RPC from `@whitespace/shared/chains` | JSON-RPC for the app's own chain reads. Not handed to the wallet. Leave unset in production; see the note in `.env.example` |
| `NEXT_PUBLIC_SITE_URL` | `https://www.whitespace.finance` | Public origin for absolute URLs in share previews (`og:image`) |
| `NEXT_PUBLIC_HUNTER_RPC_URL` | public 1875 RPC from `@whitespace/shared/chains` | RPC for the Hunter badge reads on mainnet |
| `NEXT_PUBLIC_HUNTER_EXPLORER` | `https://explorer.whitechain.io` | Explorer used for Hunter collection links |
| `API_INTERNAL_BASE_URL` | `NEXT_PUBLIC_API_BASE_URL` | Server-only: where the Next server reaches the API when rendering share pages and cards |

`.env.example` also lists `NEXT_PUBLIC_CHAIN_ID=1874`, but no code reads it; the chain id is the
`CHAIN_ID` constant.

## Development

Requires Node 22 and pnpm 9 (see the root [README](../../README.md)). For a full local
stack (chain, indexer, API, keeper, bots) use `tools/stack/acceptance-anvil.sh` from the root
README. Without a running API the terminal still renders and its chain reads still work; the
API-backed panels show their empty or stale state.

| Command | What it does |
|---|---|
| `pnpm --filter @whitespace/web dev` | `next dev` on port 3000 |
| `pnpm --filter @whitespace/web build` | `next build` (production bundle) |
| `pnpm --filter @whitespace/web start` | `next start`, serves the build |
| `pnpm --filter @whitespace/web typecheck` | `tsc --noEmit` |

`@whitespace/shared` ships plain ESM source and is compiled by Next through
`transpilePackages` ([`next.config.mjs`](next.config.mjs)).

## Tests

### Unit (Vitest)

```bash
pnpm --filter @whitespace/web test         # vitest run
pnpm --filter @whitespace/web test:watch   # vitest
```

jsdom with Testing Library; files match `tests/unit/**/*.test.{ts,tsx}`, setup in
`tests/unit/setup.ts`. The `@/` alias resolves to `src/`.

### End-to-end (Playwright)

```bash
pnpm --filter @whitespace/web e2e:install  # once: playwright install --with-deps chromium
pnpm --filter @whitespace/web e2e          # playwright test
```

[`playwright.config.ts`](playwright.config.ts) starts its own `next dev -p 4300` (reused
locally if already running, never in CI) and runs the specs in `tests/e2e/` in Chromium. No
real chain or API is needed:

- `mockBackend.ts` intercepts the API, which the config points at the same-origin
  `http://127.0.0.1:4300/__api`. The WebSocket URL is unreachable on purpose, so E2E exercises
  the REST-poll fallback.
- `mockChain.ts` and `installMockWallet.ts` serve JSON-RPC reads and an injected
  `window.ethereum` for wallet writes against an in-memory chain state (`testState.ts`).

CI runs `typecheck`, `test`, `build`, then `e2e`, in that order.
