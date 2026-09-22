# Closing a position must not depend on the wallet balance

Status: design approved, implementation pending. Migration is a separate go.

## The problem, as measured

A trader with three open positions could not close any of them. Reverted tx
`0x8a357f2b0fd3dd0262afb9b20235ebf3e27453a8e253e5dbccf4f4260e1addd2`
(`closeTradeMarket(0, 3, 10000, …)`, block 8491850). Replayed with `eth_call` at block
8491849; the revert data decodes to:

```
ERC20InsufficientBalance(0x43Ac…B06B, balance 57243, needed 1000000)
                                      = 0.057243 USDW   = 1.00 USDW
```

`pairOracleFee(0)` read live = `1000000`, exactly the `needed`.
`OstiumTrading.sol:310-311` pulls it **from the wallet**:

```solidity
uint256 oracleFee = pairsStorage.pairOracleFee(pairIndex);
storageT.transferUsdc(sender, address(storageT), oracleFee);
```

Opening charges the same amount, so a trader who spends their balance down on margin
cannot close what they opened. The faucet cannot rescue them either —
`USDW.claim()` reverts `CooldownActive`, one mint per address per 24h
(`contracts/src/mocks/USDW.sol:27-30`).

## What the charge actually is

Not a fee. `OstiumTradingCallbacks.sol:336-342`:

```solidity
if (closePercentage == 100e2) {
    // Full close and successfully closed - refund the oracle fee
    storageT.refundOracleFee(oracleFee);
    storageT.transferUsdc(address(storageT), t.trader, oracleFee);
}
```

| event | net to trader |
|---|---|
| full close executes | **0** — refunded in the same transaction |
| close cancels (slippage, market closed) | −1 USDW → `devFees` |
| partial close executes | −1 USDW (no refund branch) |

So it is a **refundable anti-griefing bond**, and the trader was blocked by the need to
post a deposit that would have been handed straight back. The upstream comment says as
much: *"Always charge oracle fee for both partial and full closes to prevent griefing."*

Griefing is already bounded independently: `TradingLib.checkNoPendingTriggers` reverts a
second close request with `TriggerPending`, and `maxPendingMarketOrders` caps pending
orders per trader. The bond's only remaining teeth are on the **cancel** path.

## Design: the bond becomes a lien

Stop posting the bond at request time. Charge it, from the position's own collateral, only
on the paths where it has teeth.

| | today | designed | net |
|---|---|---|---|
| full close executes | −1 at request, +1 refund | nothing moves | 0 = 0 |
| close cancels | −1 (already taken) | −1 from collateral, here | −1 = −1 |
| partial close executes | −1 (already taken) | −1 from the released portion | −1 = −1 |

Economics are preserved exactly. The wallet stops being involved, and the common path —
a full close that executes — touches no balances it did not already touch.

### Why not deduct at request time

Considered and rejected. Collateral is not free to move: `removeCollateral`
(`OstiumTrading.sol:523-531`) shows the protocol's invariant is **notional**, not leverage:

```solidity
uint256 tradeSize   = t.collateral * t.leverage / 100;   // fixed
uint256 newCollateral = t.collateral - removeAmount;
uint32  newLeverage = tradeSize * PRECISION_6 / newCollateral / 1e4;
if (newLeverage <= t.leverage || newLeverage > maxLeverage) revert WrongLeverage(newLeverage);
```

Taking the bond out of collateral **raises leverage**, which moves the liquidation price
closer for the whole pending window, and on a position near `maxLeverage` would make the
close itself revert — the same trap wearing a different hat. Charging only on cancel and
partial close keeps the happy path free of that entirely.

It also avoids a storage-layout change. A "deferred bond" flag would have needed a new
field on `PendingMarketOrderV2`; this design adds no state.

### Guard: accounting must never block a close

When the bond is charged (cancel or partial), if either
- the position's collateral is less than the bond, or
- the recomputed leverage would exceed `getEffectiveMaxLeverage`,

then **waive the bond** rather than revert. The protocol forgoes at most 1 USDW in a rare
case; the alternative is a close that cannot complete, which is the defect being fixed.

## Why this is a migration, not an upgrade

An earlier reading of this problem assumed `trading` was an upgradeable proxy, because
`OstiumTrading is IOstiumTrading, Delegatable, Initializable` and the EIP-1967
implementation slot is populated. **That assumption is wrong.** Verified three ways:

- `UUPSUpgradeable`, `_authorizeUpgrade`, `upgradeTo`, `upgradeToAndCall` — no match
  anywhere in `OstiumTrading.sol` or `src/vendor/ostium/abstract/`.
- `script/Deploy.s.sol:99` deploys `new ERC1967Proxy(implementation, initCall)` — a bare
  proxy with no admin and no upgrade entry point.
- The live runtime code is 77 bytes: read slot, `delegatecall`, return. The ERC-1967 admin
  slot is `0x0` because it was never set.

The implementation address can never be changed. `Initializable` is present only because
upstream Ostium deploys behind upgradeable proxies; this deployment did not.

The route that does exist is the registry. Authorisation is resolved per call:

```solidity
if (msg.sender != registry.getContractAddress('trading')) revert NotTrading(msg.sender);
```

`OstiumRegistry.updateContract(bytes32,address)` is `onlyGov`. So a **new** Trading and a
**new** TradingCallbacks are deployed and the registry is repointed at them.
`TradingStorage` is not touched, so open positions, balances and `devFees` survive.

**Both contracts move.** `callbacks` is behind the same bare proxy (runtime code 155 bytes
hex, identical shape), and the refund removal lives in `OstiumTradingCallbacks`.

## Open blocker

Registry gov is `0xFB042739DaA0946E9e6658CA6603Ff5EcEa60Dd8`. That address appears
**nowhere in this repository**, and is not the deployer (`0xDa13C59838D9edDBD313b9B32FC47F5F2D65D113`,
which owns USDW). Without its key the registry cannot be repointed and none of this can
ship. Confirm control before scheduling the migration.

## Scope of change

| file | change |
|---|---|
| `OstiumTrading.sol` `closeTradeMarket` | delete the `transferUsdc` + `handleOracleFee` pair |
| `OstiumTradingCallbacks.sol` | delete the full-close refund branch; charge the bond from collateral on cancel and on partial close, with the waive guard |
| `apps/web` | close no longer depends on wallet balance; `describeTxError`'s insufficient-balance sentence stops naming closing |

`removeCollateral` and `topUpCollateral` keep charging the bond from the wallet. They are
not the reported defect, they are optional actions a trader can decline, and each already
requires a funded wallet for other reasons.

## Testing

Forge tests against a fork of 1874, which is the only place the real state exists:

- a position whose owner holds **zero** USDW closes fully, and the payout equals today's
  payout for the same inputs — the parity assertion that proves economics are unchanged
- a cancelled close debits exactly one bond from collateral and leaves the position open
- a partial close debits exactly one bond
- a position within one bond of `maxLeverage` still closes, with the bond waived
- a position whose collateral is below one bond still closes, with the bond waived
- `devFees` after each path equals the figure the current contracts produce

## Rollback

The registry is the switch. If the new Trading misbehaves, `updateContract('trading', …)`
back to `0x9f7F9be7731E805B0b9174465257f0C1Ab589f27` and `('callbacks', …)` back to
`0x4084cd63dB84c88c98418e33b88449b3b006da9c` restores the current system, because
`TradingStorage` never changed. Pending orders in flight at the moment of the switch are
the one hazard: drain them first, or accept that in-flight closes cancel.
