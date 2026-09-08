# Phase 3 decisions — price publisher and keeper

Status: **implemented and unit-tested; not deployed, and no on-chain transaction was sent.**
`services/price-publisher` was run live against the four real venues and served a real
signed v2 report. `services/keeper`'s watcher/ABI was proven, read-only, against a real
historical log on testnet 1874. Nothing under `contracts/` was touched (another agent owns
that concurrently); the k-of-N verifier this wire format targets is not deployed yet, so
`performUpkeep` was never called.

---

## 1. What was built

```
packages/shared/src/
  bounds.mjs        every named threshold (staleness, spread, deviation, min healthy
                     venues, EMA window/sample interval, plus the contract-side
                     bounds, reference-only)
  markets.mjs        BTC/USD, ETH/USD registry: feedId (bytes32) + per-venue symbol
  venues.mjs         canonical venue id list + weights
  decimal.mjs        exact bigint 18-decimal parsing/formatting/bps math
  keys.mjs           loads ~/.whitespace-keys/*.json role keys, never logs them
  orderTypes.mjs     mirrors IOstiumPriceUpKeep.OrderType (uint8 <-> name)

packages/reporter/src/
  report-v2.mjs      NEW FILE, additive only. v1 exports in report.mjs untouched.
                     buildReportDataV2, signReportV2, recoverReportSignerV2,
                     sortSignaturesByAddress, encodeSignedReportV2,
                     signAndEncodeReportV2

services/price-publisher/src/
  aggregator.mjs     pure: midOf, spreadBpsOf, median, weightedMedian,
                     classifyVenues, computeIndex, canSignForOrderType
  ema.mjs            pure: createMarkEma (fixed-cadence discrete EMA)
  venues/{binance,bybit,okx,whitebit}.mjs   pure parse() per venue + connect metadata
  venues/index.mjs   the WS I/O layer (connectVenue), not unit-tested
  engine.mjs         per-feed state: ingestTick, sampleMark, signReportFor
  server.mjs         node:http API: /health, /status, /v2/report
  config.mjs, main.mjs

services/keeper/src/
  abi.mjs            PriceRequestedV2 / performUpkeep / NotForwarder / InvalidPrice
  watcher.mjs         pure toPriceRequestedEvent + watchPriceRequested (RPC)
  reportSource.mjs   HttpReportSource (fetches from the publisher) and
                     LocalReportSource (builds+signs locally; dev/test fallback)
  txSender.mjs       legacy type-0 send, nonce cache, 1.2x gas bump, dead-letter
  deadLetter.mjs     in-memory + optional file-persisted queue
  keeperEngine.mjs   wires watcher event -> reportSource -> encodePerformData -> txSender
  rpc.mjs            viem fallback() transport across >=1 configured RPC endpoints
  config.mjs, main.mjs
```

`packages/shared/package.json` and `packages/reporter/package.json` gained subpath
`exports` entries for the new modules; their existing `"."` exports are untouched.
`services/price-publisher` and `services/keeper` are new pnpm workspace packages
(`services/*` was already in `pnpm-workspace.yaml`); `pnpm install` at the repo root
picked them up and resolved `ws@8.21.0` and the workspace links — no other file changed.

---

## 2. The wire format, exactly as specified

`report-v2.mjs` builds `abi.encode(uint256 chainId, address verifier, bytes32 feedId,
uint32 timestamp, int192 price, int192 bid, int192 ask, bool isMarketOpen, bool
isDayTradingClosed)`, signs `keccak256("\x19Ethereum Signed Message:\n32" ||
keccak256(reportData))` per key, and encodes `abi.encode(bytes reportData, bytes[]
signatures)` with signatures **sorted ascending by the address each one actually
recovers to** — not by the address the caller claims signed it
(`packages/reporter/test/report-v2.test.mjs`, "sorted ascending by the RECOVERED
signer" test independently recovers every signature after encoding and compares).

`encodePerformData(signedReport, orderId)` from the untouched `report.mjs` is reused
as-is to build `performData` — it is `abi.encode(bytes, uint256)`, format-agnostic
about what's inside the bytes, so no v2 duplicate was needed. Proven in
`report-v2.test.mjs`.

### Live proof, not just unit tests

Ran `node src/main.mjs` in `services/price-publisher` against the real Binance, Bybit,
OKX and WhiteBIT WebSocket feeds for ~15s (`PUBLISHER_SIGNATURE_THRESHOLD_K=1` so the
one real key at `~/.whitespace-keys/signer.json` could complete a full sign — see
§5). `curl`'d `/v2/report?feed=BTC%2FUSD&timestamp=1757325600&orderType=MARKET_CLOSE`
and decoded the response with `decodeAbiParameters`:

```
chainId 1874n
verifier 0xf2236F1Cc7610D75DD1D38563aA090bdD7102Fc8
feedId 0x4254432f55534400000000000000000000000000000000000000000000000000
timestamp 1757325600
price 78891385772085405087899
bid 78891400000000000000000
ask 78891480000000000000000
isMarketOpen true
isDayTradingClosed false
num signatures 1, sig bytes len 65
```

The recovered signer, `0x8981eacdCAc3c4afAb9AD5F7A4ACBB3e5C81a86E`, is exactly the
`signer` role address already registered on-chain per
`deployments/1874-operational.json`. `/status` during the run showed the aggregate
moving live between healthy (3-4 venues) and momentarily degraded (WhiteBIT dropping
to 1-2 venues), logged as `[price-publisher] BTC/USD DEGRADED: ...` — the surfaced,
non-silent state the spec requires.

---

## 3. How each bound is enforced, and tested

All bounds live in `packages/shared/src/bounds.mjs`, imported everywhere they're used
— none is a literal at its use site.

| Bound | Value | Enforced in | Proven in (both directions) |
|---|---|---|---|
| Venue staleness | 2 s | `aggregator.classifyVenues` (`age > stalenessBoundMs`) | `aggregator.test.mjs`: a tick 1ms over the bound is rejected `stale`; a tick 1ms under is not |
| Venue spread width | 10 bps | `aggregator.classifyVenues` via `spreadBpsOf` | `aggregator.test.mjs`: ~20bps spread rejected `wide_spread`; ~5bps spread passes |
| Venue deviation vs median-of-others | 50 bps | `aggregator.classifyVenues`, leave-one-out (each candidate judged against the median of every *other* surviving candidate, not one that includes itself) | `aggregator.test.mjs`: a venue ~200bps off the other two is rejected `deviant` and the other two remain healthy; three venues within a few bps of each other all pass |
| Min healthy venues | 3 | `aggregator.computeIndex` (`degraded = healthyCount < minHealthyVenues`) | `aggregator.test.mjs`: 3 healthy -> not degraded; 2 healthy -> degraded but still has an index; 0 healthy -> degraded AND `noData`; an explicit 4-healthy-to-2-healthy transition flips `degraded` false->true |
| Mark EMA window | 10 s | `ema.createMarkEma` (`alpha = 2/(N+1)`, `N = windowMs/sampleIntervalMs`) | `ema.test.mjs`: exact hand-computed step values, a 10x single-tick spike smoothed to a computed exact value (not applied in full), monotonic convergence, a shorter window reacting faster than a longer one |
| Do-not-sign gate | opens blocked / closes allowed while degraded; everything blocked with zero healthy venues | `aggregator.canSignForOrderType`, consumed by `engine.signReportFor` | `aggregator.test.mjs` (gate in isolation) and `engine.test.mjs` end-to-end: a disagreeing venue set produces **no `signedReport` key at all** in the result, not a signed bad one; degraded mode signs `MARKET_CLOSE`/`REMOVE_COLLATERAL` but refuses `MARKET_OPEN`/`LIMIT_OPEN` with `degraded_opens_blocked` |
| 18-decimal exactness | — | `decimal.parseDecimalTo18`, bigint only, no float in any price path | `decimal.test.mjs`: `"65000"` -> `65000000000000000000000n` exactly; truncation (not rounding) beyond 18 fractional digits is asserted with an exact expected value |
| Signature order | strictly ascending by recovered signer | `report-v2.sortSignaturesByAddress` + `signAndEncodeReportV2` | `report-v2.test.mjs` and `engine.test.mjs`: signatures are independently re-recovered post-encoding and the recovered list is asserted strictly ascending — proves the sort key is the real recovered address, not the claimed one |

Contract-side bounds (`maxAge`, `maxDeviationBps`, `k=3/N=5`,
`marketOrdersTimeoutBlocks`) are captured in `bounds.mjs` too, but only as named
constants for operator reference — this package cannot and does not enforce them; the
concurrent verifier work does.

---

## 4. Design decisions not fully pinned by the spec

### 4.1 `isMarketOpen` (wire field) vs. degraded mode (publisher policy) are different axes

The wire format's `isMarketOpen`/`isDayTradingClosed` booleans are Ostium's
market-hours fields (relevant to TradFi-hours assets on the Chainlink Data Streams
path they were designed for); crypto is 24/7 per design spec §1, so this publisher
always sets `isMarketOpen: true`. "Degraded: closes allowed, opens blocked" is a
**separate** policy this implementation added at the sign-decision layer:
`engine.signReportFor(feed, timestamp, orderTypeName)` takes the order type and
refuses to produce a `signedReport` for `MARKET_OPEN`/`LIMIT_OPEN` while degraded,
via `aggregator.canSignForOrderType`. The publisher's HTTP API therefore requires the
caller (the keeper) to pass `orderType`, and returns HTTP 409 with a reason instead of
a report when refusing. This is a reasonable, tested reading of §7's error table, not
a literal spec quote — flagging it explicitly in case the on-chain design intended
`isMarketOpen: false` to carry this meaning instead (it can't, structurally: that
would zero the price for closes too, per `OstiumPrivatePriceUpKeep.performUpkeep`'s
`if (!isMarketOpen) { delete a.price; ... }`, defeating "closes allowed").

### 4.2 Index bid/ask, not just index price

The signed report's `bid`/`ask` fields are the weighted median of healthy venues'
bids and asks independently (`aggregator.computeIndex` returns `indexBid`/`indexAsk`
alongside `index`), not `mark ± offset`. `price` is the EMA-smoothed mark;
`bid`/`ask` are unsmoothed index values, matching how Ostium's existing v1 reports
carry a mark-like `price` plus separately-quoted `bid`/`ask` (see
`packages/reporter/test/report.test.mjs` fixture).

### 4.3 WhiteBIT is a genuine order-book diff stream, not a repeated snapshot

Verified live (2026-09-08) against `wss://api.whitebit.com/ws`: only the first
`depth_update` after subscribing is a full snapshot; every later message patches
whichever side changed, with a `"0"`-volume level meaning "remove". `venues/whitebit.mjs`
maintains a local `{bids, asks}` `Map` and applies diffs (`applyDepthUpdate`), tested
with real captured message shapes in `venues.test.mjs` (full seed, partial patch,
zero-volume removal, and the "no two-sided quote yet" null case). This is materially
different from Binance/Bybit/OKX, which all push a complete top-of-book every message.

### 4.4 Bybit's `tickers` channel has no bid/ask at all

Also discovered live: Bybit v5 spot `tickers.<symbol>` carries `lastPrice` and 24h
stats only — no book fields — despite the REST `/v5/market/tickers` endpoint having
`bid1Price`/`ask1Price`. Using `tickers` would have silently violated "mid of best
bid/ask, never last trade." Switched to `orderbook.1.<symbol>` (depth-1), which does
push a full best-bid/best-ask snapshot every message.

---

## 5. What was NOT verified, and why

1. **No on-chain transaction was sent, ever, by either service.** `performUpkeep` was
   never called. The k-of-N verifier this wire format targets does not exist yet on
   1874 — `deployments/1874.json`'s `verifier` field
   (`0xf2236F1Cc7610D75DD1D38563aA090bdD7102Fc8`) is the OLD 1-of-N `OstiumVerifier`
   (read directly from `contracts/src/vendor/ostium/OstiumVerifier.sol`; it decodes
   `(bytes, bytes32, bytes32, uint8)` — one signature — not `(bytes, bytes[])`).
   Calling it with a v2 `signedReport` would not decode as intended. This is expected,
   not a bug: the task brief states the on-chain verifier is being built concurrently
   by another agent, and `contracts/` was correctly left untouched. `config.mjs` in
   both services documents this and takes `PUBLISHER_VERIFIER_ADDRESS` /
   `KEEPER_PRICE_UPKEEP_ADDRESS` overrides for when the new verifier lands.
2. **Genuine k=3-of-5 signing was never exercised against real signer keys.** Only one
   real role key exists on disk, `~/.whitespace-keys/signer.json` (confirmed by
   listing `~/.whitespace-keys/` — the other six files there are `gov`, `owner`,
   `manager`, `marketmaker`, `dev`, `keeper`, none of them additional signers). The
   live publisher run above used `PUBLISHER_SIGNATURE_THRESHOLD_K=1` to exercise a
   full sign+serve round trip with that one real key; k-of-N was only proven with
   synthetic generated keys in `report-v2.test.mjs` and `engine.test.mjs`. Provisioning
   4 more signer key files is an operational task, not a code gap.
3. **RPC failover was never exercised against a second real 1874 endpoint** — only one
   public RPC URL for chain 1874 is documented anywhere in this repo
   (`https://rpc.testnet.whitechain.io`). `rpc.mjs` builds a viem `fallback()`
   transport over a configurable list; with one URL configured it has nothing to fail
   over to. The mechanism itself (`fallback()`) is a viem library feature, not
   hand-rolled, and is out of scope to fake-test meaningfully here.
4. **The keeper's watcher and ABI *were* verified, read-only, against real chain
   state**: queried `eth_getLogs` for `PriceRequestedV2` on the deployed
   `OstiumPrivatePriceUpKeep` (`0x3Ce549F5Aa65141D10f25BE793d63572bC3908Be`) around the
   block of the recorded proof trade (`deployments/1874-operational.json`,
   `openOrderId: 2`) and ran the real log through `watcher.toPriceRequestedEvent`:
   `{orderId: 2, orderType: 0 ("MARKET_OPEN"), feed: <BTC/USD feedId, exact match>,
   timestamp: 1788881079}`. `1788881079` is nowhere near wall-clock time at the point
   this was run — independent confirmation that the timestamp path really does carry
   the log's own value, not `Date.now()`. No transaction was sent; `getLogs` and
   `getTransactionReceipt` are read-only.
5. **`services/keeper/src/main.mjs` (the live watch-and-submit loop) was not run.**
   Running it against 1874 today would either sit idle (no new orders) or, if it saw a
   fresh `PriceRequestedV2`, attempt `performUpkeep` against the old verifier and
   revert — spending the keeper key's gas balance for a result that reveals nothing
   new. Triggering a *fresh* order to generate a live event would itself be an
   on-chain action (opening a real trade) outside this task's scope to decide
   unilaterally.
6. **Exchange API terms of use for redistributing market data** — explicitly out of
   scope per the design spec §12.9 ("not reviewed... before mainnet"); unchanged by
   this phase.
7. **Root `package.json` declares `"engines": {"node": ">=22"}`**; the environment
   this was built and tested in runs Node 20.18.1 (as the task brief mandates: "Node
   20, ESM... `node:test`"). All tests pass on 20.18.1. Not changed — pre-existing
   repo metadata, out of scope for this task, flagged here rather than silently
   worked around.

---

## 6. Exact test commands and output

```
$ cd packages/shared && node --test test/
# tests 18
# pass 18
# fail 0

$ cd packages/reporter && node --test test/
# tests 13
# pass 13
# fail 0

$ cd services/price-publisher && node --test test/
# tests 58
# pass 58
# fail 0

$ cd services/keeper && node --test test/
# tests 21
# pass 21
# fail 0
```

129 new/changed tests total, all green. Pre-existing `node --test tools/` (19 tests,
unrelated to this phase) was re-run to confirm nothing else broke: 19/19 pass.

No lint or format tooling is configured anywhere in this repository (checked for
`.eslintrc*`, `eslint.config.*`, `.prettierrc*`, and a `lint`/`format` script in every
`package.json` — none exist), so there is no whole-repo lint gate to run.

### Reproducing the live venue run

```bash
cd services/price-publisher
PUBLISHER_PORT=8787 PUBLISHER_MARKETS='BTC/USD,ETH/USD' PUBLISHER_SIGNATURE_THRESHOLD_K=1 \
  PUBLISHER_SIGNER_KEY_PATHS="$HOME/.whitespace-keys/signer.json" \
  node src/main.mjs
# in another shell, once /status shows degraded:false for a feed:
curl "http://127.0.0.1:8787/v2/report?feed=BTC%2FUSD&timestamp=<any-uint32>&orderType=MARKET_CLOSE"
```

### Reproducing the read-only keeper/chain check

```bash
cd services/keeper
node -e "
import('viem').then(async ({ createPublicClient, http }) => {
  const { whitechainTestnet1874 } = await import('./src/rpc.mjs');
  const { PRICE_UPKEEP_ABI } = await import('./src/abi.mjs');
  const { toPriceRequestedEvent } = await import('./src/watcher.mjs');
  const client = createPublicClient({ chain: whitechainTestnet1874, transport: http('https://rpc.testnet.whitechain.io') });
  const logs = await client.getLogs({
    address: '0x3Ce549F5Aa65141D10f25BE793d63572bC3908Be',
    event: PRICE_UPKEEP_ABI.find(e => e.type === 'event' && e.name === 'PriceRequestedV2'),
    fromBlock: 7284709n, toBlock: 7284713n,
  });
  console.log(logs.map(toPriceRequestedEvent));
});
"
```

---

## 7. Contradictions encountered (none blocking)

No spec-vs-reality contradiction required stopping. The two ambiguities worth a
reviewer's attention are §4.1 (`isMarketOpen` vs. degraded-mode policy) and the fact
that the currently deployed verifier is the pre-hardening 1-of-N contract (§5.1) —
both are design gaps the spec left for phase 3/2 to resolve jointly, not
inconsistencies within the spec itself.
