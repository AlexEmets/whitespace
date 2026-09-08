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

None in phase 1. The tree is byte-identical to upstream. Any future divergence must be recorded
in this table with its rationale:

| File | Change | Rationale | Commit |
|---|---|---|---|
| _(none)_ | | | |

### Deliberately NOT modified

`src/lib/ChainUtils.sol` retains its Arbitrum branch. `getBlockNumber()` gates on
`block.chainid` and returns `block.number` for every non-Arbitrum chain, so it is already
correct on 1874, 2625 and 1875. Keeping it byte-identical preserves the ability to merge
upstream fixes. See `test/ChainUtils.t.sol`, which pins this behaviour.
