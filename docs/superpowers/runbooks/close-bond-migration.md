# Runbook — migrating the close-bond change onto chain 1874

**Status: blocked, not scheduled.** The registry gov key is not in this repository. Read
"Precondition" before anything else. Nothing here has been executed.

Design: `docs/superpowers/specs/2026-09-22-close-without-wallet-balance-design.md`.

## Why this is a redeploy and not an upgrade

Both contracts that change are behind a **bare** `ERC1967Proxy`. Verified three ways:

- `UUPSUpgradeable`, `_authorizeUpgrade`, `upgradeTo`, `upgradeToAndCall` — no match anywhere
  in `OstiumTrading.sol`, `OstiumTradingCallbacks.sol`, or `src/vendor/ostium/abstract/`.
- `script/Deploy.s.sol:99` deploys `new ERC1967Proxy(implementation, initCall)` — no admin,
  no upgrade entry point.
- The live runtime code of `trading` is 77 bytes (read slot, `delegatecall`, return), and
  the ERC-1967 admin slot reads `0x0` because it was never set. `callbacks` has the same
  155-hex-char runtime.

`Initializable` on the implementations is misleading — it is there because upstream Ostium
deploys behind upgradeable proxies. This deployment did not. The implementation address can
never be changed.

What *is* switchable is the registry. Authorisation is resolved per call:

```solidity
// OstiumTradingStorage.sol:107-108
if (msg.sender != registry.getContractAddress('trading')) revert NotTrading(msg.sender);
```

So new contracts are deployed and the registry is repointed at them.

## Precondition — the blocker

`OstiumRegistry.updateContract(bytes32,address)` is `onlyGov`.

| | value |
|---|---|
| registry | `0xD6Cc323BF2736B121586B2929E0E27a80DDCC98A` |
| gov | `0xFB042739DaA0946E9e6658CA6603Ff5EcEa60Dd8` |
| gov type | **EOA** — `eth_getCode` returns `0x`; nonce 24; balance 0.0580 WBT |
| deployer / USDW owner | `0xDa13C59838D9edDBD313b9B32FC47F5F2D65D113` — a **different** address |

Gov is a plain private key that has transacted 24 times, presumably while wiring the
deployment. It appears nowhere in this repository. **Find where that key lives before
scheduling anything below.** Gov being an EOA rather than a multisig means each repoint is a
single `cast send`, not a signer ceremony.

## What survives

`tradingStorage` (`0xb51217a43BF812B354E18977a4781909C4d33341`) is **not** redeployed. Open
positions, trader balances, `devFees`, open interest and the pair registry all live there and
are untouched. That is the whole reason this is a repoint rather than a state migration.

## Current addresses — also the rollback targets

| key | address |
|---|---|
| `trading` | `0x9f7F9be7731E805B0b9174465257f0C1Ab589f27` |
| `callbacks` | `0x4084cd63dB84c88c98418e33b88449b3b006da9c` |

Write these down before starting. Rollback is `updateContract` back to exactly these two.

## The mismatch window

Between the two `updateContract` calls the system is internally inconsistent:

- old `trading` + new `callbacks` → the bond is charged at request time and never refunded.
  Traders lose 1 USDW per full close.
- new `trading` + old `callbacks` → no bond is charged, but the old callback still tries to
  refund one on a full close. `OstiumTradingStorage.refundOracleFee:465-470` reverts
  `RefundOracleFeeFailed` once `devFees` is exhausted, which **fails the close callback**.

The second is worse: it can strand closes. Therefore:

1. Repoint `callbacks` **first**, then `trading`, in immediate succession. The window then
   overcharges rather than stranding.
2. Better: drain pending orders first (see below), so nothing is in flight during the window.

## Procedure

1. **Drain.** Confirm there are no pending market orders. Any close pending at the moment of
   the switch will be served by a callback that no longer matches the trading contract that
   accepted it — those cancel. Announce it or wait for the queue to clear.
2. **Deploy both.** Deploy new `OstiumTrading` and `OstiumTradingCallbacks` implementations,
   each behind its own `ERC1967Proxy`, initialised the same way `script/Deploy.s.sol:157-159`
   and `:187` do. `--legacy` is required on 1874. Foundry auto-links `TradingLib` and
   `TradingCallbacksLib`; do not pass `--libraries`.
3. **Verify before switching.** Read the new proxies' implementation slots and confirm the
   registry still points at the OLD pair. Nothing is live yet.
4. **Repoint, callbacks first:**
   ```bash
   cast send $REGISTRY "updateContract(bytes32,address)" \
     $(cast format-bytes32-string callbacks) $NEW_CALLBACKS \
     --rpc-url https://rpc.testnet.whitechain.io --legacy --private-key $GOV_KEY
   cast send $REGISTRY "updateContract(bytes32,address)" \
     $(cast format-bytes32-string trading) $NEW_TRADING \
     --rpc-url https://rpc.testnet.whitechain.io --legacy --private-key $GOV_KEY
   ```
5. **Prove it took.** `cast call $REGISTRY "getContractAddress(bytes32)(address)"` for both
   keys must return the new addresses. Then exercise the actual defect: from a wallet holding
   **zero** USDW with an open position, close it. That is the acceptance test — not that the
   transactions mined.
6. **Update the frontend.** `apps/web/src/lib/deployment.ts` reads addresses from
   `deployments/1874.json`; update both entries and redeploy the web app. The old addresses
   stay valid as rollback targets.

## Rollback

`updateContract` back to the two addresses in the table above, callbacks first again.
`tradingStorage` never changed, so no state is lost. Positions opened during the new
contracts' tenure remain valid — they live in the same storage.

## Do not

- Do not redeploy `tradingStorage`. Open positions would be orphaned.
- Do not run both `updateContract` calls from separate sessions minutes apart.
- Do not skip step 5's zero-balance close. "Both transactions mined" is not evidence the
  defect is fixed.
