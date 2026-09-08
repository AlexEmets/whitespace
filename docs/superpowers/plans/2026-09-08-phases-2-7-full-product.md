# Phases 2–7: from a tradeable testnet market to a complete product

Phases 0, 1 and 1.5 are done: contracts deployed on Whitechain 1874, a BTC/USD market
configured, and one real position opened and closed through the genuine two-phase price
flow (`deployments/1874-operational.json`). What remains is everything that makes it a
product rather than a proof.

## Scope, honestly stated

This is not one session's work. It is a production perpetual DEX: threshold-signed
oracle, multi-venue price pipeline, keeper, indexer, API, trading UI, liquidator, and an
invariant suite. The ordering below is by dependency and by risk, so that if work stops
at any point, what exists is coherent rather than half of everything.

## Locked coordination decisions

These exist so independently-built components cannot diverge. Change them only by
changing this section first.

### D1 — Hardened oracle contracts are NEW files, not vendor edits

The design (§4.2, §6) requires `Verifier` to go 1-of-N → k-of-N and to grow rails. The
global constraint forbids touching `contracts/src/vendor/`, which is byte-identical to
upstream `8390ce49` and asserted by `contracts/VENDOR.md`.

Resolution: write `contracts/src/oracle/WhitespaceVerifier.sol` and
`WhitespacePriceUpKeep.sol` as new contracts implementing the same interfaces, and swap
them in through the registry (`ostiumVerifier` and `<oracle>PriceUpkeep` keys). The
vendor tree stays pristine and upstream fixes stay mergeable.

This also resolves a problem the design flagged as blocking: the vendored `verify()` is
`external view`, so it cannot record the last accepted price that the deviation rail
needs. Our own upkeep is not `view`, so the rail lives there — which is where it belongs
anyway, since the rail is per-feed and the verifier is per-system.

### D2 — Report wire format

Both the on-chain verifier and the off-chain publisher were built independently against
this. It is the contract between them.

```
reportData = abi.encode(
    uint256 chainId,      // must equal block.chainid
    address verifier,     // must equal the verifier contract address
    bytes32 feedId,
    uint32  timestamp,
    int192  price,        // 18 decimals
    int192  bid,
    int192  ask,
    bool    isMarketOpen,
    bool    isDayTradingClosed
)

signedReport = abi.encode(bytes reportData, bytes[] signatures)   // 65 bytes each, r||s||v

digest = keccak256(abi.encodePacked("\x19Ethereum Signed Message:\n32", keccak256(reportData)))
```

`chainId` and `verifier` are domain separation: a report signed for one chain or one
verifier instance is unusable on another. Signatures must be ordered by **strictly
ascending recovered signer address** — this is what stops one signature being replayed
k times to reach the threshold, and it makes duplicate detection O(n).

### D3 — Read API surface

Fixed before the frontend starts, so the UI is not rebuilt against a moving target.

```
GET  /health                     GET  /markets            GET  /markets/:pairIndex
GET  /markets/:pairIndex/candles?interval=&from=&to=
GET  /positions/:address         GET  /positions/:address/history
GET  /orders/:address            GET  /price/:pairIndex
WS   /ws  channels: price:<pair> | positions:<addr> | orders:<addr> | candles:<pair>:<interval>
```

Every monetary value is a **decimal string** with a documented scale — never a JSON
number, which silently loses precision above 2^53.

### D4 — Parameter split: publisher filters, contract backstops

| Parameter | Value | Enforced by |
|---|---|---|
| Venue staleness | 2 s | publisher |
| Venue spread width | 10 bps | publisher |
| Venue deviation vs median of others | 50 bps | publisher |
| Minimum healthy venues | 3 of 4 | publisher |
| Mark EMA window | 10 s | publisher |
| Report `maxAge` | 10 s | contract |
| `maxDeviationBps` vs last accepted | 500 bps | contract |
| Signature threshold | k=3 of N=5 | contract |

The contract bounds are deliberately looser. A rail that trips in normal operation is a
liveness bug, not a safety feature.

## Phases

| # | Phase | Gate | State |
|---|---|---|---|
| 2 | Oracle hardening: k-of-N verifier + rails | verifier invariant tests green | in progress |
| 3 | Price publisher + keeper | order completes end-to-end on testnet | in progress |
| 4 | Indexer + API | positions and candles served correctly | in progress |
| 5 | Frontend | mouse-driven trade from deposit to close | blocked on 4 |
| 6 | Liquidator + monitoring | liquidation fires automatically | blocked on 3 |
| 7 | Hardening: adversarial tests, audit prep | invariants hold under fuzzing | blocked on 2–6 |

Phase 5 is a pure consumer of D3, and phase 6 reuses phase 3's signing and delivery
machinery, so neither is started early — duplicating that machinery would cost more than
waiting for it.

## Invariants phase 7 must prove (design §8)

1. Vault solvency: `assets >= sum of payouts across all positions`.
2. Conservation: `collateral in positions + vault balance = deposited - withdrawn`.
3. Open interest never exceeds its cap under any operation ordering.
4. A position below maintenance margin is always liquidatable.
5. `verify()` never accepts a report with fewer than k signatures, for any input.

Invariant 5 is built in phase 2 rather than deferred, because it is the property the
whole threshold scheme exists to provide.

## Carried-forward hazards

- **Silent failure is this codebase's dominant failure shape.** Three configuration
  steps found in phase 1.5 (`setMaxOpenInterest`, `setPairFundingFees`,
  `setVaultMaxAllowance`) all produced *successful transactions* with no position, a
  panic inside price delivery, or opens that could never be closed. Any test asserting
  only "the call did not revert" is worthless here; assert the observable state.
- **A wrong price exponent never reverts.** 18 decimals for price, 6 for collateral,
  2 for leverage.
- **Gas is not replaceable** — the faucet is CAPTCHA-gated and needs a human. Everything
  is proven on anvil before it touches 1874.
- **Chain 2625 is unfunded** and mainnet 1875 has no stablecoin. Both are business
  blockers, not engineering tasks.
