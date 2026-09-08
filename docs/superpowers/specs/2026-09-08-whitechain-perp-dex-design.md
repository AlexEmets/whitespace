# Whitechain Perpetual DEX — Design Specification

**Date:** 2026-09-08
**Status:** Approved (design); implementation plan pending
**Scope:** Fully working perpetual futures DEX on Whitechain testnet, portable to Whitechain mainnet

---

## 1. Locked decisions

These were decided with the user and are inputs to the plan, not open questions.

| Decision | Value | Consequence |
|---|---|---|
| Relationship to WhiteBIT | **Independent project** — no privileged access | No exchange oracle, no seeded liquidity, no market-making agreement |
| Deliverable | **Full product on testnet**, audit-ready | Every component real; no mocks in the critical path except collateral |
| Target network | **Whitechain testnet 1874 (OP Stack)**, built Shanghai-compatible | Modern dev environment; mainnet 1875 stays reachable |
| Contract base | **Fork of Ostium V2** (MIT) | Inherit matching, margin, funding, liquidation logic |
| Counterparty model | **Shared LP vault** (oracle-priced), not an order book | Works with zero market makers |
| Markets | **Crypto only**: BTC and ETH at launch, then 3 more | 24/7 trading; no market-hours or weekend-gap logic |

The three additional markets are selected in phase 3 by measured venue liquidity — the criterion
is that at least 3 of the 4 ingest venues quote the pair with a spread inside the width bound.
BTC and ETH are fixed; nothing else is committed in this spec.

---

## 2. Target chain: measured facts

All values below were obtained on 2026-09-07/08 by direct JSON-RPC calls against the public
endpoints, and by executing opcode probes via `eth_call` with init-code payloads. They are
measurements, not documentation claims.

### 2.1 Three networks under one brand

| Property | Mainnet **1875**<br>`rpc.whitechain.io` | Testnet **2625**<br>`rpc-testnet.whitechain.io` | Testnet **1874**<br>`rpc.testnet.whitechain.io` |
|---|---|---|---|
| Client | `Geth/v1.3.0` | `Geth/v1.3.0` | `reth/v2.2.0` |
| Consensus | Clique PoA (`difficulty=2`) | Clique PoA (`difficulty=2`) | **OP Stack rollup** (`difficulty=0`) |
| Block time | 2.00 s | not measured | 1.00 s |
| Gas limit | 30,000,000 | 30,000,000 | 40,000,000 |
| Gas price | 10 gwei, fixed | not measured | EIP-1559, base 5 gwei |
| EIP-1559 / `BASEFEE` | **absent** | **absent** | present |
| `PUSH0` (Shanghai) | present | present | present |
| `MCOPY`/`TSTORE`/`TLOAD` (Cancun) | **absent** | **absent** | present |
| `withdrawalsRoot` | absent | absent | present |
| CREATE2 deployer `0x4e59…` | **absent** | **absent** | present |
| Multicall3 | present | **absent** | present |
| Permit2 | **absent** | **absent** | present |
| Safe singleton/factory | absent | absent | not probed |
| ERC-4337 EntryPoint v0.6/v0.7 | absent | absent | not probed |
| Uniswap V3 factory | absent | absent | absent |

**Method note.** Opcode support was probed by `eth_call` with init code that executes the
opcode then returns one byte, e.g. `0x5f50600160005260016000f3` for `PUSH0`. An unsupported
opcode returns `invalid opcode: 0x… not defined`. A `PUSH1` control payload confirmed the
harness itself was sound.

### 2.2 Testnet 1874 is an OP Stack rollup

Seven canonical OP Stack predeploys are present on 1874 and **absent** on 1875:
`L1Block` (`0x42…15`), `L2ToL1MessagePasser` (`…16`), `L2StandardBridge` (`…10`),
`L2CrossDomainMessenger` (`…07`), `GasPriceOracle` (`…0F`), `SequencerFeeVault` (`…11`),
`L2ERC721Bridge` (`…14`). `L1Block.timestamp()` tracks a live L1 whose base fee is ~1 gwei.

At 1.00 s/block and ~7.25M blocks, testnet 1874 is roughly 84 days old — a recent deployment,
consistent with a next-generation stack rather than the mirror of the current mainnet.

### 2.3 Mainnet 1875 has low smart-contract activity ~~effectively none~~

Sampling 200 mainnet blocks: **82 transactions, 144 blocks empty (72%), 0.4 tx/block**. Every
top recipient was an **EOA** — not a single contract call was observed in the sample. No
stablecoin, DEX, or lending market was found.

~~**Implication:** the perp DEX would be the chain's first real DeFi application, and there is
currently **no collateral asset on mainnet to trade against**.~~ **Superseded — see correction
below.**

**Correction to §2.3 (2026-09-08).** The 200-block sample was too small to see token activity
that is sparse rather than absent. A wider probe — `eth_getLogs` over the ERC-20 `Transfer`
topic (`0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef`) across the most
recent 1,000,000 blocks on `rpc.whitechain.io` — found **478 Transfer events across 4 token
contracts**, independently re-counted from the raw `eth_getLogs` response:

| Contract | Name / symbol | Decimals | Transfers /1M blocks |
|---|---|---|---|
| `0xf97b9bf62916f1eb42dd906a7254603e7b9fc4a7` | Bridged USDC (Whitechain) / `USDC.e` | 6 | 322 |
| `0xb044a2a1e3c3deb17e3602bf088811d9bdc762ea` | Wrapped WBT / `WWBT` | 18 | 152 |
| `0xee623f9ef066e6ecd382d81d377866ab342e2fcd` | WhiteBIT GEL / `WBGEL` | 6 | 2 |
| `0xd372a78934a5e66c17fecfa28ce13f5787b72f63` | Test Bridged eUAH / `teUAH` | 6 | 2 |

322 transfers in 1,000,000 blocks is one roughly every 3,106 blocks, so a 200-block sample had
about a 6% chance of catching one — the original sample missing all activity was consistent
with sparse-but-real usage, not proof of absence. `USDC.e`'s `totalSupply()` is `337525000000`
(≈337,525 USDC.e), and its most recent transfer in the sweep was ~2.6 hours before this
correction was written (block 48898431 vs. chain head 48903090, ×2.00 s/block). See §10.2 for
the full correction and its consequence for mainnet portability.

### 2.4 RPC surface

`eth_getLogs`, `eth_feeHistory`, `eth_createAccessList` are available. `debug_traceTransaction`,
`trace_block`, and `txpool_*` are **not available** on the public endpoint.

**Implication:** the indexer must be log-based. Trace-dependent indexing is not an option.

---

## 3. Fork base and licensing

Licenses were verified by reading the actual `LICENSE` files, not repository descriptions.

| Project | License | Usable? |
|---|---|---|
| GMX v2 `gmx-synthetics` | **BUSL-1.1** | No — commercial use prohibited |
| GMX v2 `gmx-interface` | **BUSL-1.1** | No |
| SYMM.io `protocol-core` | **BUSL-1.1** (Symmetry Labs AG) | No |
| dYdX v4 `v4-chain` | Custom + AGPL, Cosmos not EVM | No |
| Vertex `vertex-contracts` | **No license file** | No |
| Gains `gTrade-v6.1` | **No license** | No |
| **GMX v1 `gmx-contracts`** | **MIT** | Yes |
| **Ostium V2 `smart-contracts-public`** | **MIT** | **Yes — selected** |
| Perpetual Protocol v2 | GPL-3.0 | Copyleft |
| MUX | GPL-2.0 | Copyleft |
| Synthetix v3 | MIT but **archived** | Discouraged |

### 3.1 Why Ostium

Ostium V2 states in its README that it is *"adapted from the Gains v5 open-source codebase"*
and publishes under **MIT**. It is therefore the legally clean route into the Gains lineage,
whose own repositories carry no license.

Concrete advantages, all verified by reading the code:

1. **A complete non-Chainlink oracle path already exists.** Two interchangeable contracts
   implement `IOstiumPriceUpKeep`:
   - `OstiumPriceUpKeep` → Chainlink Data Streams (`IChainlinkVerifierProxy`, `IChainlinkFeeManager`)
   - `OstiumPrivatePriceUpKeep` → `IOstiumVerifier`, **zero Chainlink imports**

   Selection is by registry lookup (`registry.getContractAddress('ostiumVerifier')`) —
   configuration, not a rewrite.
2. **`OstiumVerifier` is self-contained**: ~60 lines, `ecrecover` against a gov-managed
   authorized-signer map. No external dependency.
3. **Two-phase order execution is already implemented**, defeating price-front-running
   (see §5.1).
4. **Compact**: 46 `.sol` files, ~17 core contracts.
5. **Timeout recovery exists**: `openTradeMarketTimeout` refunds `trade.collateral` to the
   trader; `closeTradeMarketTimeout` additionally refunds the oracle fee. Verified by reading
   `OstiumTrading.sol:652-748`.
6. **Toolchain aligns with the constraint**: 40 files at `pragma ^0.8.24`; solc 0.8.24 defaults
   to `evm_version = shanghai`, exactly the opcode set mainnet 1875 supports.

### 3.2 Why not an order book

Hyperliquid runs a genuine fully on-chain CLOB — its docs state the book *"works in essentially
the same way as all centralized exchanges but is fully on-chain"*, matched in price-time
priority, and that HyperCore *"does not rely on the crutch of off-chain order books"*.

What that required (from the same docs): **HyperBFT**, a bespoke HotStuff consensus variant; a
matching engine inside chain state; **median 0.2 s / p99 0.9 s** end-to-end latency;
**~200,000 orders/sec**; and a mempool that is *semantically aware of order-book transactions*,
sorting actions within a block so that cancels execute before aggressive orders.

None of that is reachable as EVM contracts on a 1-second-block chain with an ordinary public
mempool. Notably, even on Arbitrum no team keeps the book on-chain — Vertex, Paradex, Aevo and
Bluefin all moved matching off-chain and settle on-chain.

**Decisive argument for this project:** an order book with no market makers is an empty screen.
This is an independent team, with no MM relationships, on a chain measured at 0.4 tx/block. The
oracle-priced vault model exists precisely because it provides tradeable liquidity with **zero**
market makers — liquidity is bought with vault capital rather than negotiated.

Note that the two models are not opposed: Hyperliquid runs vaults *and* a book, where the vault
supplies liquidity into the book.

### 3.3 Accepted costs of the vault model

- **No price discovery.** The protocol is a price taker; oracle correctness is existential.
- **LPs absorb trader PnL.** Fees, spread and funding must cover it.
- **OI caps bound growth.** Volume is limited by vault size, not by demand.
- **No maker spread** as a revenue line.

### 3.4 What cannot be inherited

The Ostium organisation has **7 repositories and no frontend**: contracts, two Python SDKs, a
closed indexer, a token list, a key utility. A GitHub search for permissively-licensed perp DEX
frontends returned only toy projects (★0–2). The only mature open perp frontend,
`gmx-interface`, is BUSL-1.1.

**Split of work:**
- **Inherited:** contracts — matching, isolated margin, funding, liquidations, LP vault.
  Roughly 70% of the difficulty and effectively 100% of the fatal-error surface.
- **Built:** price publisher, keeper, liquidator, indexer, API, frontend. Large in volume, but
  ordinary software: a defect costs uptime, not user funds.

The boundary falls in the right place — we inherit where mistakes are unrecoverable and write
where they are.

---

## 4. Architecture

```
┌──────────────────────────────────────────────────────────────┐
│  apps/web            Next.js · wagmi/viem · charts           │
└─────────┬──────────────────────────────────┬─────────────────┘
          │ reads (REST/WS)                  │ writes (wallet-signed)
┌─────────▼───────────┐                      │
│  services/api       │                      │
│  candles, positions │                      │
└─────────▲───────────┘                      │
          │                                   │
┌─────────┴───────────┐                      │
│  services/indexer   │  Ponder → Postgres   │
└─────────▲───────────┘                      │
          │ eth_getLogs                       │
┌─────────┴───────────────────────────────────▼────────────────┐
│  CONTRACTS on Whitechain 1874 (fork of Ostium V2, MIT)        │
│  Trading · TradingStorage · TradingCallbacks · Vault · OpenPnl│
│  PairsStorage · PairInfos · PriceRouter · Verifier · Registry │
└─────────▲─────────────────────────────▲──────────────────────┘
          │ signed reports               │ liquidations
┌─────────┴──────────┐      ┌────────────┴─────────┐
│ services/keeper    │      │ services/liquidator  │
└─────────▲──────────┘      └────────────▲─────────┘
          │                               │
┌─────────┴───────────────────────────────┴────────────────────┐
│  services/price-publisher                                     │
│  Binance/Bybit/OKX/WhiteBIT WS → index → k-of-N signatures    │
└───────────────────────────────────────────────────────────────┘
```

### 4.1 Repository layout

```
whitespace/
├─ contracts/            Foundry; fork of Ostium V2
│  ├─ src/core/          Trading, TradingStorage, TradingCallbacks, PairsStorage, PairInfos
│  ├─ src/vault/         Vault, OpenPnl, LockedDepositNft
│  ├─ src/oracle/        Verifier (hardened), PriceUpKeep, PriceRouter
│  ├─ src/access/        Registry, GovGuard, Timelock
│  ├─ src/lib/           TradingLib, TradingCallbacksLib, ChainUtils (de-Arbitrum'd)
│  ├─ test/              unit · fuzz · invariant · fork
│  └─ script/            deployment
├─ services/
│  ├─ price-publisher/   CEX ingest → index → sign
│  ├─ keeper/            delivers signed reports
│  ├─ liquidator/        monitors margin, triggers liquidations
│  ├─ indexer/           Ponder
│  └─ api/               REST + WebSocket
├─ apps/web/             trading UI
├─ packages/
│  ├─ sdk/               typed contract bindings
│  └─ shared/            types, market registry, config
└─ docs/
```

### 4.2 Contract changes required

| # | Change | Reason |
|---|---|---|
| 1 | ~~`ChainUtils`/`IArbSys` → `block.number`~~ **Not required — see below** | Corrected 2026-09-08 |
| 2 | Chainlink Automation forwarder → own keeper allowlist | No Automation; already parameterised via `registerForwarder` |
| 3 | **`Verifier`: 1-of-N → k-of-N threshold** | See §6 — the central security work |
| 4 | Oracle rails: staleness, max deviation, per-market breaker | On Arbitrum, Chainlink is the backstop; here there is none |
| 5 | Pin `solc 0.8.24`, `evm_version = shanghai` | Mainnet 1875 portability |

**Correction to change #1 (2026-09-08).** An earlier draft of this spec claimed `ChainUtils` had
to be rewritten because the Arbitrum `ArbSys` precompile is absent on Whitechain. Reading the
source disproves it:

```solidity
function getBlockNumber() internal view returns (uint256) {
    if (block.chainid == ARBITRUM_MAINNET || block.chainid == ARBITRUM_GOERLI
        || block.chainid == ARBITRUM_SEPOLIA) {
        return ARB_SYS.arbBlockNumber();
    }
    return block.number;
}
```

The Arbitrum branch is gated on `block.chainid` and is **never taken** on 1874, 2625 or 1875;
`ARB_SYS` is a `constant` address, so no call is made. The library is already correct on
Whitechain.

**Decision: keep `ChainUtils` unmodified.** Minimal divergence from upstream keeps future
upstream fixes mergeable, and the dead branch costs no gas. A regression test pins the behaviour
for our three chain ids instead. Removing it would be cosmetic churn against a live dependency.

---

## 5. Data flows

### 5.1 Order lifecycle — two-phase

```
TRADER              CONTRACTS                     KEEPER          PUBLISHER
  │ openTrade(pair, collateral, leverage, dir, slippage)
  ├────────────────► Trading
  │                   ├─ validate: leverage, OI caps, market active
  │                   ├─ store pending order in TradingStorage
  │                   └─ PriceRouter.getPrice(orderId, pair, ts)
  │                        └─ emit PriceRequested ───────────►│
  │                                                            │ request report
  │                                                            ├──────────────►│
  │                                                            │◄──────────────┤ signed
  │                     performUpkeep(report) ◄────────────────┤
  │                   Verifier.verify(report)
  │                   └─ TradingCallbacks.openTradeCallback
  │                        ├─ apply spread + price impact
  │                        ├─ check trader's slippage tolerance
  │◄───────────────────────┴─ position opened OR cancelled
```

**Why two phases.** The trader commits **before the price is known**; the execution price comes
from a report signed **after** the request. Single-phase execution against a stored oracle price
is directly exploitable: observe that the oracle lags spot, then open at the stale price. This
is the GMX v1 AVAX exploit class.

**Consequence for the UI.** `slippage` here is not spot-market slippage protection — it is the
trader's **only** defence against an unfavourable execution price. The default must be tight and
displayed explicitly.

### 5.2 Price pipeline

```
Binance  WS ─┐
Bybit    WS ─┼─► normalise ─► outlier rejection ─► weighted median = INDEX
OKX      WS ─┤                                          │
WhiteBIT WS ─┘                            mark = EMA(index) + funding basis
                                                        │
                          signer-1 … signer-N ──► k signatures over one hash
                                                        │
                                                 report store (HTTP/WS)
```

Index construction rules:

- Per-venue price = **mid of best bid/ask**, never last trade (last trade is manipulable with a
  single cheap order).
- A venue is **rejected** if its data is older than the staleness bound, its spread exceeds the
  width bound, or it deviates from the median of the others beyond the deviation bound.
- **Minimum 3 healthy venues.** Below that the market enters **degraded mode: closes allowed,
  opens blocked**.
- **Mark price = EMA of index**, so a single tick cannot trigger a liquidation cascade.

**Initial parameter values.** These are starting points to be tuned against measured data in
phase 3, not final constants. They are stated so the implementation is unambiguous.

| Parameter | Initial value | Where enforced |
|---|---|---|
| Venue staleness bound | 2 s | publisher |
| Venue spread width bound | 10 bps | publisher |
| Venue deviation bound vs median of others | 50 bps | publisher |
| Minimum healthy venues | 3 of 4 | publisher |
| Mark EMA window | 10 s | publisher |
| Report `maxAge` | 10 s | contract |
| `maxDeviationBps` vs last accepted price | 500 bps | contract |
| Signature threshold | k=3 of N=5 | contract |
| `marketOrdersTimeout` | 30 blocks (30 s at 1 s/block) | contract |

The contract bounds are deliberately looser than the publisher bounds: the publisher is the
tuned filter, the contract is the backstop. A contract rail that trips during normal operation
would be a liveness bug, not a safety feature.

### 5.3 Liquidations

The liquidator maintains a position table from the indexer, computes the margin ratio against
**the same index the contract will see**, and submits below maintenance margin — through the
same two-phase price flow. Liquidation is **permissionless with a reward**: this is both a
decentralisation property and redundancy for when our own liquidator is down.

---

## 6. Oracle hardening — the central risk

### 6.1 Current state

```solidity
address signer = ecrecover(...);
if (!isAuthorizedSigner[signer]) revert NotAuthorizedSigner(signer);
```

**One key controls the price of every market.** On Arbitrum, Chainlink stands beside this as an
independent source. On Whitechain there is nothing.

### 6.2 Layer 1 — threshold signatures (k-of-N)

`verify()` accepts an array of signatures over one report hash and requires:

- **≥ k distinct authorized signers** (initial parameters: **k=3, N=5**);
- signer addresses **strictly ascending**, which rejects the same signature replayed to reach
  the threshold;
- the report payload includes `pairIndex`, `price`, `bid`, `ask`, `timestamp`, **`chainId` and
  the verifier address** — domain separation against replay onto another chain or contract.

### 6.3 Layer 2 — contract rails, independent of signers

| Rail | Failure it catches |
|---|---|
| `maxAge` — reject stale reports | frozen or replayed feed |
| `maxDeviationBps` vs last accepted price | aggregation bug producing a jump |
| Per-market circuit breaker | incident on one asset |
| Global pause (guardian role, immediate) | everything else |
| Parameter changes via timelock only | governance compromise |

### 6.4 Why both layers

They catch **different failures**, and neither covers the other:

- **k-of-N** defends against key compromise. If all N signers are honest but receive the **same
  wrong input**, all N will honestly sign a falsehood. The threshold is powerless there.
- **The deviation rail** catches exactly that case: it does not ask *who* signed, it asks whether
  the **number itself** is plausible. It works when signers are flawless and the aggregation
  logic is broken.

This is defense in depth in the strict sense — two checks on two different assumptions, not two
checks of the same thing.

### 6.5 Sequencer liveness

1874 is an OP Stack chain. If the sequencer stalls, prices freeze while positions persist.
Liquidating at prices the market never saw is unacceptable, so a **recovery window** applies:
after an extended outage, liquidations do not resume immediately. This mirrors Chainlink's
dedicated sequencer-uptime feed on Arbitrum.

---

## 7. Error handling

| Failure | Effect | Response |
|---|---|---|
| Venue disconnects | fewer sources | drop it, continue on the rest |
| Healthy venues < 3 | index unreliable | **degraded: closes yes, opens no** |
| Venues disagree | aggregate suspect | **do not sign**; `maxAge` then blocks trading |
| Keeper down | orders pending | `openTradeMarketTimeout` — trader reclaims collateral |
| Keeper tx reverts | order unexecuted | gas bump, nonce manager, dead-letter queue |
| Liquidator down | positions unclosed | liquidation is **permissionless** + alert |
| Chain reorg | indexer state diverges | Ponder unwinds natively |
| RPC down | blindness | failover across ≥2 endpoints, then own node |
| Sequencer stall | prices frozen | recovery window before liquidations resume |
| Signer key compromised | forged prices | k-of-N threshold + deviation rail |

---

## 8. Testing strategy

Migrate to **Foundry** (upstream uses Hardhat) for one reason: **invariant testing**.

**Invariants** — properties a fuzzer attacks with millions of random operation sequences:

1. Vault solvency: `assets ≥ sum of payouts across all positions`.
2. Conservation: `collateral in positions + vault balance = deposited − withdrawn`
   (money is never created).
3. Open interest never exceeds its cap **under any operation ordering**.
4. A position below maintenance margin is **always** liquidatable.
5. `verify()` never accepts a report with fewer than k signatures, **for any input**.

Supporting layers: unit and fuzz tests; fork tests against live testnet 1874; integration runs
on `anvil` with the full service stack; **adversarial scenarios** — oracle manipulation, keeper
censorship, liquidation races, compromise of 1 and of 2 keys out of 5; `Slither` and `Echidna`;
Playwright E2E; a load test measuring liquidation latency at N open positions.

---

## 9. Phases

| # | Phase | Completion gate |
|---|---|---|
| **0** | Scaffolding: monorepo, pinned solc, `USDW` deploy, pre-EIP-155 probe | trivial contract deployed on 1874 **and** 2625 |
| **1** | Contract port: remove `IArbSys`, build under shanghai | compiles and deploys to both networks |
| **2** | **Oracle hardening**: k-of-N + rails | verifier invariant tests green |
| **3** | Price publisher + keeper | an order completes end-to-end on testnet |
| **4** | Indexer + API | positions and candles served correctly |
| **5** | Frontend | mouse-driven trade from deposit to close |
| **6** | Liquidator, monitoring, risk dashboard | liquidation fires automatically |
| **7** | Hardening: adversarial tests, audit prep | invariants hold under fuzzing |

---

## 10. Mainnet portability

### 10.1 Under our control — enforced from phase 0

- Pinned `solc 0.8.24` with **`evm_version = shanghai`**. The upstream `^0.8.24` caret is a
  hazard: solc ≥ 0.8.25 defaults to `cancun` and would silently emit `MCOPY`, producing
  bytecode that cannot deploy on mainnet 1875.
- **Legacy type-0 transactions** for all keeper and liquidator traffic — valid on both the
  1559 and non-1559 networks.
- **No dependency on Permit2** and none on the CREATE2 deployer for address derivation.
- CI deploys to **both** 1874 and 2625 (the mainnet mirror). Incompatibility fails the build
  the same day it is introduced.

**Caveat on 2625 as a mirror.** It matches mainnet on client, consensus and opcode set, but it
is *not* identical: mainnet has Multicall3 deployed and 2625 does **not**. The divergence runs
in the safe direction — 2625 is the stricter environment, so code that passes there also runs on
mainnet — but a CI failure on 2625 alone must be diagnosed rather than assumed to be a real
mainnet incompatibility.

### 10.2 Outside our control — business blockers, not engineering

| Blocker | Measured state |
|---|---|
| ~~**No stablecoin on mainnet**~~ | ~~zero contract calls observed in a 200-block sample~~ — **refuted, see correction below** |
| No verified bridge for inbound funds | none confirmed |
| No Safe multisig deployed | Safe is open source; we can deploy it |
| No CREATE2 factory on 1875 | its canonical deployment needs a pre-EIP-155 transaction — **phase-0 must verify the chain accepts these** |
| Audit before real funds | $50–150k, out of testnet scope |

~~**The load-bearing sentence.** "Works perfectly on testnet" is an engineering problem and it is
solvable. "Then on mainnet" is **not an engineering problem** — it is blocked by the absence of
a stablecoin to trade against. This plan guarantees that *the code will not be the obstacle*:
when a stablecoin and bridge appear, deployment is a day's work, because CI will have been
proving compatibility continuously. What the plan cannot do is create liquidity.~~

**Correction to §10.2 (2026-09-08).** The "no stablecoin" blocker above rested on a 200-block
sample that found zero contract calls (§2.3) and read that as absence. The sample was too small:
token activity on 1875 is sparse, not absent. A 1,000,000-block `eth_getLogs` sweep on the
ERC-20 `Transfer` topic (`0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef`),
re-run directly against the public RPCs for this correction, found:

- **Mainnet 1875**: 478 Transfer events across 4 token contracts (table in §2.3), including
  `USDC.e` — "Bridged USDC (Whitechain)", 6 decimals, `totalSupply()` ≈337,525 USDC.e, still
  actively transferring (most recent event ~2.6 h before this correction was written).
- **Testnet 1874**: the same-named "Bridged USDC (Whitechain)" / `USDC.e` token at
  `0x5eb541ba8a2dd841af7864c3389162a23dda8401`, 6 decimals, `totalSupply()` = 6,020 USDC.e.
- **Testnet 2625**: 5 active token contracts, 1,511 Transfer events over the same
  1,000,000-block window (busier than mainnet) — but **not** the same bridged-USDC contract.
  Reading `name()`/`symbol()`/`decimals()` on all five found four other 6-decimal test
  stablecoins ("Test USD" `USDW`, "Thether TUSDT" `TUSDT`, "Test EURC" `tEURC`, "AgentPay USD"
  `apUSD`) plus `WWBT` (18 decimals) — no `USDC.e`-named contract among them. The specific
  bridged-USDC contract exists on mainnet and on testnet 1874, not on 2625; 2625 instead already
  hosts its own set of 6-decimal test stablecoins, one of which happens to already be named
  `USDW` — the same ticker §11 proposes deploying (see the note there).

6 decimals is exactly what the vendored Ostium contracts expect for collateral. **Conclusion:
mainnet 1875 already has a live, 6-decimal bridged-USDC asset with real (if sparse) transfer
activity. Mainnet deployment is an engineering path, not a business dead end** — the load-bearing
sentence above no longer holds as written. What remains genuinely outside engineering control is
whether that asset is *suitable* collateral for a leveraged exchange (see the new risk below),
and the bridge-verification, Safe, CREATE2 and audit rows, which this correction does not touch.

**New risk surfaced: mainnet `USDC.e` has a single centralizing admin key.** Verified directly
against `0xf97b9bf62916f1eb42dd906a7254603e7b9fc4a7` on `rpc.whitechain.io`:

- `paused()` → `false` — not currently paused, but pausable.
- `owner()` and `blacklister()` both resolve to the **same address**,
  `0xF31663436d0731015ad0e84603d25576cb9F5230`.
- `implementation()` → `0xaA8145fe0081964F754fa247A5719F3712F3AddF`, while the standard
  EIP-1967 implementation-slot read returns zero — this is the Centre `FiatToken` pattern (a
  non-standard, non-EIP-1967 proxy), not a transparent/UUPS proxy.

One address can pause transfers, blacklist any holder, and upgrade the implementation of the
asset an exchange would settle in. That is a systemic dependency this spec did not previously
record anywhere. **Not decided here:** whether that risk is acceptable for this project, whether
`0xF31663...` is a multisig or an EOA, and whether mainnet collateral should be `USDC.e` as-is,
a wrapped/vetted version of it, or something else — these need an explicit decision before §1's
"mainnet 1875 stays reachable" framing is acted on.

---

## 11. Collateral and gas

**Collateral.** ~~No stablecoin exists on Whitechain.~~ **Superseded 2026-09-08 — see §10.2
correction.** A live 6-decimal bridged `USDC.e` exists on mainnet 1875 and on testnet 1874;
testnet 2625 has its own distinct set of 6-decimal test stablecoins, one of them already named
`USDW` at an address this project does not control. On testnet we deploy our own `USDW` (6
decimals) with a faucet, behind an interface so a real stablecoin substitutes without core
changes. **Open decision, not resolved by this correction:** whether to keep deploying a
project-owned `USDW` mock or integrate the pre-existing bridged/test tokens directly, and
whether mainnet collateral should be `USDC.e` as-is given the admin-key risk in §10.2.

**Gas.** Mainnet is 10 gwei with no EIP-1559; testnet 1874 has EIP-1559 active. All automated
transactions are formed as **legacy type 0**, valid on both.

---

## 12. Not verified / open questions

Recorded explicitly so no reader mistakes these for established facts.

1. **DefiLlama was unreachable** (non-JSON response). No perp DEX volume or LP-return figures
   were independently measured. The architecture comparison in §3.2 rests only on documentation
   and source code read directly.
2. ~~Whether mainnet 1875 accepts pre-EIP-155 transactions~~ **Answered 2026-09-08.**
   `eth_sendRawTransaction` with an unprotected signature returned: `only replay-protected
   (EIP-155) transactions allowed over RPC`. Conclusion: pre-EIP-155 transactions are
   **rejected**, therefore the canonical CREATE2 factory at `0x4e59b448…` **cannot** be
   deployed on mainnet. Consequence for the design: address derivation must not assume
   CREATE2, as already required by the Global Constraints.
3. **Safe and ERC-4337 presence on testnet 1874** — not probed.
4. **Whitechain's roadmap** — whether mainnet migrates to the OP Stack is inferred from the
   testnet's client and age, not from an official statement.
5. **Whether testnet 2625 is the canonical mirror of mainnet 1875** — inferred from matching
   client, consensus and opcode set; not officially confirmed.
6. **Ostium audit reports and security history** — not reviewed. Required before phase 7.
7. **Whitechain testnet faucet availability and rate limits** — not tested.
8. **L1 that testnet 1874 settles to** — its `L1Block.basefee()` is ~1 gwei; the specific chain
   was not identified.
9. **Exchange API terms of use** — whether Binance/Bybit/OKX permit redistribution of their
   market data as a signed oracle feed has not been reviewed. Legal check before mainnet.
10. **Added 2026-09-08.** Custody of the mainnet `USDC.e` admin key — `owner()` and
    `blacklister()` on `0xf97b9bf62916f1eb42dd906a7254603e7b9fc4a7` are the same address,
    `0xF31663436d0731015ad0e84603d25576cb9F5230` (see §10.2); whether it is an EOA or a
    multisig, who controls it, and its pause/blacklist/upgrade history have not been
    investigated. Required before treating mainnet `USDC.e` as viable collateral.

---

## 13. Sources

Primary sources only; all fetched or probed on 2026-09-07/08.

1. `https://rpc.whitechain.io`, `https://rpc.testnet.whitechain.io`,
   `https://rpc-testnet.whitechain.io` — direct JSON-RPC probes
2. `https://github.com/0xOstium/smart-contracts-public` — MIT; source read directly
3. `https://github.com/gmx-io/gmx-synthetics/blob/master/LICENSE` — BUSL-1.1
4. `https://github.com/gmx-io/gmx-interface/blob/master/LICENSE` — BUSL-1.1
5. `https://api.github.com/repos/SYMM-IO/protocol-core/license` — BUSL-1.1, Symmetry Labs AG
6. `https://api.github.com/repos/gmx-io/gmx-contracts` — MIT
7. `https://hyperliquid.gitbook.io/hyperliquid-docs/hypercore/overview.md`
8. `https://hyperliquid.gitbook.io/hyperliquid-docs/hypercore/order-book.md`
9. `https://hyperliquid.gitbook.io/hyperliquid-docs/hypercore/clearinghouse.md`
10. `https://hyperliquid.gitbook.io/hyperliquid-docs/trading/order-book.md`
11. `https://hyperliquid.gitbook.io/hyperliquid-docs/trading/market-making.md`
