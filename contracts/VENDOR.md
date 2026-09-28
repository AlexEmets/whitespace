# Vendored dependencies

## Ostium V2 — `src/vendor/ostium/`

| Field | Value |
|---|---|
| Upstream | https://github.com/0xOstium/smart-contracts-public |
| Commit | `8390ce497f68fb128900840e0ec30683afa945d3` |
| Date | 2026-05-07 (release v1.5.0) |
| License | **MIT** — `LICENSE` file and all 46 `SPDX-License-Identifier` headers |
| Files | 46 `.sol` |

### Licence note

Upstream `package.json` declares `"license": "ISC"` while the `LICENSE` file and every source
header declare MIT. Both are permissive and impose no copyleft obligation. We treat **MIT** as
governing, since it is what the LICENSE file and the per-file SPDX headers say. The upstream
`LICENSE` is preserved verbatim at `src/vendor/ostium/LICENSE`.

Upstream README credits the Gains Network v5 codebase as the origin of this design.

### Local modifications

Byte-identical to upstream through phase 1. Every divergence since is recorded here:

| File | Change | Rationale | Where |
|---|---|---|---|
| `OstiumTrading.sol`, `OstiumTradingCallbacks.sol`, `OstiumTradingStorage.sol`, `lib/TradingCallbacksLib.sol`, `interfaces/IOstiumTradingCallbacks.sol`, `interfaces/IOstiumTradingStorage.sol` | The close oracle-fee bond is charged from the position on a cancelled or partial close instead of pulled from the wallet at request time; `refundOracleFee` removed; `OracleFeeBondCharged` event | Traders who spent their balance on margin could not close (tx `0x8a357f2b…`) | branch `feat/close-bond-from-position`, spec `docs/superpowers/specs/2026-09-22-close-without-wallet-balance-design.md` |
| `lib/TradingCallbacksLib.sol` | `withinExposureLimits` takes the fill price and charges a short's notional at `price / fillPrice` | A short admitted exactly at `maxOi` landed above it after price impact | `test/unit/Findings.t.sol`, `docs/decisions/testnet-perfect-contract-tests.md` |

### Deliberately NOT modified

`src/vendor/ostium/lib/ChainUtils.sol` retains its Arbitrum branch. `getBlockNumber()` gates on
`block.chainid` and returns `block.number` for every non-Arbitrum chain, so it is already
correct on 1874, 2625 and 1875. Keeping it byte-identical preserves the ability to merge
upstream fixes. See `test/ChainUtils.t.sol`, which pins this behaviour.

That is the path **on disk**. Vendored sources import the same file as `src/lib/ChainUtils.sol`
(e.g. `OstiumTrading.sol:3`), which resolves only because `remappings.txt` maps
`src/lib/` → `src/vendor/ostium/lib/`. There is no `src/lib/` directory. The same aliasing
applies to `src/interfaces/` and `src/abstract/`; when a path in this file or a report does not
exist under `contracts/`, check `remappings.txt` before concluding it is wrong.

---

## EIP-170 headroom — read this before touching `foundry.toml`

**`OstiumTrading` has 162 bytes of margin against the 24,576-byte EIP-170 runtime limit.**

Measured on this branch with `forge build --sizes` (solc 0.8.24, `evm_version = shanghai`,
`optimizer_runs = 200`, `via_ir = true`, `bytecode_hash = "none"`, `cbor_metadata = false`):

| Contract | Runtime size | Margin | Margin % |
|---|---|---|---|
| `OstiumTrading` | 24,414 B | **162 B** | 0.66% |
| `OstiumTradingCallbacks` | 22,851 B | 1,725 B | 7.0% |
| `OstiumPairInfos` | 22,112 B | 2,464 B | 10.0% |
| `OstiumTradingStorage` | 19,034 B | 5,542 B | 22.6% |
| `OstiumVault` | 19,120 B | 5,456 B | 22.2% |

`OstiumTrading` is the entry point for every user-facing action, so an overflow here is not a
peripheral failure — it is the branch's most central contract becoming undeployable.

Changes that consume this margin, in rough order of how easily they do it:

- **Raising `optimizer_runs`** above 200. Higher values trade code size for execution gas; this
  is the single most likely way to blow the limit.
- **Re-enabling metadata** — setting `bytecode_hash` to anything but `"none"`, or
  `cbor_metadata = true`. Either appends a CBOR trailer to every artifact. (Both are also
  asserted by `tools/evm-compat/toolchain.mjs`, which fails the build if they change.)
- **Disabling `via_ir`**, changing `solc_version`, or changing `evm_version` — all alter codegen.
- **Adding code to `OstiumTrading` itself**, or inlining anything currently in `TradingLib`.

`forge build --sizes` exits non-zero on an overflow; plain `forge build` and `forge test` do
**not**. CI runs `--sizes`, and so does `pnpm build:contracts`, so a local build gates this too —
but a bare `forge build` in `contracts/` will not warn you.
