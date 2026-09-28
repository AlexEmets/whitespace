<div align="center">

# ◐ Whitespace

**Perpetual futures on Whitechain, without an order book.**

Trade BTC, ETH, SOL and WBT with up to 100× leverage against a shared liquidity vault,
priced by a 3-of-5 signed oracle that watches five exchanges at once.

[**Live testnet →**](https://www.whitespace.finance/trade) &nbsp;·&nbsp;
[Docs](https://www.whitespace.finance/docs) &nbsp;·&nbsp;
[Faucet](https://www.whitespace.finance/faucet) &nbsp;·&nbsp;
[Design spec](docs/superpowers/specs/2026-09-08-whitechain-perp-dex-design.md)

![chain](https://img.shields.io/badge/chain-Whitechain%20testnet%201874-5b7bff)
![solidity](https://img.shields.io/badge/solidity-0.8.24%20·%20shanghai-363636)
![contract tests](https://img.shields.io/badge/contract%20tests-334%20passing-2bd9a0)
![coverage](https://img.shields.io/badge/coverage-76%25%20lines-2bd9a0)

</div>

---

## Why no order book?

An order book with no market makers is an empty screen. Hyperliquid can run a fully on-chain
book because it built its own consensus, a matching engine inside chain state and a mempool
that sorts cancels before takers. None of that exists on a 1-second EVM chain.

So Whitespace works like **Variational** and **Gains**: one vault is the counterparty to every
trade. Instead of a book, the terminal shows the vault's **two-sided quote for the size you
type**, meaning Buy at the ask and Sell at the bid after size-dependent price impact. That quote
is computed with the same formula the contract fills at, so what you see is what you get.

```
          you type 0.5 BTC
                 │
   ┌─────────────▼─────────────┐
   │  Buy  82,741.20           │   ← oracle ask + impact for 0.5 BTC
   │  Sell 82,684.90           │   ← oracle bid − impact for 0.5 BTC
   │  Spread 0.068%            │
   └───────────────────────────┘
```

## How a trade happens

Every order has two phases. You commit **before** the price exists, so nobody can trade against
a price they have already seen, which was the GMX v1 exploit class.

```
 trader ──openTrade()──► Trading ──PriceRequested──► keeper ──► publisher
                                                                  │  5 venues → median → EMA mark
                                                                  │  3-of-5 signatures
 position ◄──fill / cancel── Callbacks ◄──performUpkeep(report)───┘
                                │
                     Verifier: k-of-N, chainId + verifier bound, strictly ascending signers
                     Upkeep rails: maxAge 10 s · deviation ≤ 5% · per-feed halt · global pause
```

After that, two **automation bots** watch every open position and resting order. They trigger
liquidations, take-profits, stop-losses and limit/stop entries through an allowlisted
`TradesUpKeep`, and each trigger again settles at a freshly signed price.

## Features

| | |
|---|---|
| **Orders** | Market, Limit, Stop, with TP/SL at open or edited later |
| **Positions** | Isolated margin; add or remove margin; partial close (25/50/75%); close even with an empty wallet |
| **Risk** | Automatic liquidation; OI caps per market; dynamic spread; funding up to 100%/yr; rollover |
| **Safety valves** | Timed-out orders are reclaimable after 11 blocks; degraded feed blocks opens but never exits |
| **LP vault** | Async deposit/withdraw by settlement (hourly), share price tracks trader PnL |
| **History** | Trades (partials included), order history, funding history, realised PnL, all from the indexer |

## Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│ apps/web            Next.js 15 · wagmi · viem · the trading terminal │
└──────────┬──────────────────────────────────────────┬───────────────┘
           │ REST + WebSocket                          │ wallet-signed txs
┌──────────▼──────────┐                               │
│ services/api        │  positions, orders, fees, PnL │
└──────────▲──────────┘                               │
┌──────────┴──────────┐                               │
│ services/indexer    │  Ponder → Postgres            │
└──────────▲──────────┘                               │
           │ logs                                     ▼
┌──────────┴──────────────────────────────────────────────────────────┐
│ contracts/   Ostium V2 fork (MIT) + WhitespaceVerifier (k-of-N)     │
│              + WhitespacePriceUpKeep (rails) · Whitechain 1874      │
└──────────▲───────────────────────────────▲──────────────────────────┘
           │ price reports                 │ LIQ / TP / SL / LIMIT / STOP
┌──────────┴──────────┐        ┌───────────┴──────────────┐
│ services/keeper     │        │ services/liquidator ×2   │  (automation bots)
└──────────▲──────────┘        └───────────▲──────────────┘
           └───────────┬───────────────────┘
┌──────────────────────┴──────────────────────────────────────────────┐
│ services/price-publisher   Binance · Bybit · OKX · WhiteBIT → index │
│                            → EMA mark → 3-of-5 signed reports       │
└─────────────────────────────────────────────────────────────────────┘
```

Every service sends transactions through [`packages/txsender`](packages/txsender), which gives
one serial nonce queue per key, same-nonce replacement on a stuck receipt, and a JSON Lines
dead letter.

## Repository

```
contracts/          Foundry · vendored Ostium (see VENDOR.md) · oracle · deploy scripts · 334 tests
apps/web/           trading terminal, portfolio, vaults, faucet, docs
services/
  price-publisher/  exchange feeds → signed reports
  keeper/           delivers a report for every price request
  liquidator/       automation bot: liquidations, TP/SL, limit & stop entries
  indexer/          Ponder: positions, orders, fees, settlements, candles
  api/              REST + WS read API
packages/           shared · txsender · reporter · metrics
tools/              deploy manifest · acceptance suite · EVM-compat gates · chain probes
deploy/             systemd units, Caddy, alerts, backups
docs/               specs, plans, decisions, runbooks
```

## Quick start

```bash
# prerequisites: node ≥ 22, pnpm 9, foundry, docker
git clone --recursive git@github.com:AlexEmets/whitespace.git && cd whitespace
pnpm install

# contracts
cd contracts && forge build && forge test && cd ..

# the whole stack on a local chain, with a full end-to-end acceptance run
docker compose up -d postgres
tools/stack/acceptance-anvil.sh run
```

`acceptance-anvil.sh` boots anvil as chain 1874, deploys everything with the same script
production uses, starts the publisher (real exchange feeds), keeper, indexer, API and both
bots, and then trades through **12 scenarios**: market, partial close, TP/SL, limit, stop, margin
edits, timeouts, degraded feed, liquidation, vault, slippage and history. Each scenario reads
its result back from chain and API.

## Tests

| Suite | Tests | |
|---|---|---|
| Contracts (unit, integration, adversarial, fuzz) | 334 | `forge test` |
| Contract invariants (nightly profile: 51k calls each) | 5 | `FOUNDRY_PROFILE=invariant forge test --mt invariant` |
| Web unit | 408 | `pnpm --filter @whitespace/web test` |
| Web end-to-end (Playwright) | 15 | `pnpm --filter @whitespace/web e2e` |
| Automation bot | 159 | `pnpm --filter @whitespace/liquidator test` |
| API (ephemeral Postgres) | 124 | `pnpm --filter @whitespace/api test` |
| Indexer | 112 | `pnpm --filter @whitespace/indexer test` |
| Price publisher | 92 | `pnpm --filter @whitespace/price-publisher test` |
| Keeper · txsender · shared | 64 · 34 · 49 | `pnpm test:packages && pnpm test:services` |

The house rule ([CLAUDE.md](CLAUDE.md)) is that a new test must **fail** without the change it
covers. Invariants cover USDW conservation, TradingStorage solvency, OI never above its cap, a
position below maintenance always being liquidatable, and vault accounting.

## Deployment

The live testnet runs on chain **1874** (Whitechain, OP Stack). Addresses are in
[`deployments/1874.json`](deployments/1874.json), which is generated **from the chain's own registry**
by `tools/deploy/manifest.mjs`, never written by hand.

| | |
|---|---|
| Registry | `0x86d4EC32F8ed6e07D6176b71De05c9866A30c357` |
| Trading | `0x2379Bc62d7213604175fEfA21b584Ce51A8a01c6` |
| Vault | `0x0aC538e15e4C7a27E6E38025Bed911B8975044F0` |
| Verifier (3-of-5) | `0x233A5F2d8c66dBd88eB43E4A9C7f7A9BF2F6b1Cf` |
| Price upkeep | `0xBb1dB8F7c38E3729e623D8E711a56613F821a9FE` |
| Trades upkeep | `0x97162dD1FE0e34Cf6ca712a227f4cE4284B2fe65` |

- **Deploy from scratch:** [`docs/runbooks/redeploy-testnet-1874.md`](docs/runbooks/redeploy-testnet-1874.md), using one
  script, `DeployTestnet.s.sol`, that is idempotent and resumable, and rehearsed on anvil first.
- **Operate the server:** [`docs/runbooks/deploy-server.md`](docs/runbooks/deploy-server.md). Only Caddy faces the
  internet. Gas and disk alerts run every 30 minutes and backups daily.

Everything is built for **Shanghai** (`solc 0.8.24`, no Cancun opcodes, legacy transactions),
so the same bytecode can move to Whitechain mainnet 1875. CI gates that on every push.

## Status and honest caveats

This is a **testnet**. Collateral is `USDW`, a mintable test token (1,000 per day from the faucet).
Before mainnet the plan still needs:

- governance behind Safe + timelock (today the testnet roles are plain keys);
- signers on separate hosts or HSMs (today one process holds all five);
- an external audit;
- a decision on mainnet collateral (`USDC.e` has a single admin key that can pause and blacklist).

These are tracked in the [design spec](docs/superpowers/specs/2026-09-08-whitechain-perp-dex-design.md)
and [`docs/decisions/`](docs/decisions).

## Credits

Contracts are forked from [Ostium V2](https://github.com/0xOstium/smart-contracts-public) (MIT),
which is itself adapted from the Gains Network v5 design. Every local change to the vendored
code is listed in [`contracts/VENDOR.md`](contracts/VENDOR.md).

<div align="center"><sub>Built on Whitechain</sub></div>
