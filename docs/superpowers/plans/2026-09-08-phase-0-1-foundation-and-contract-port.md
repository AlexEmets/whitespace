# Phase 0–1: Foundation and Contract Port — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Vendor the Ostium V2 contracts into this repository and prove they compile to
Shanghai-only bytecode and deploy successfully to both Whitechain testnets.

**Architecture:** A pnpm monorepo with a Foundry contracts package. Upstream Ostium source is
vendored verbatim at a pinned commit, never edited in place during this phase. Two mechanical
gates enforce mainnet portability: a `forge config` assertion and a bytecode disassembler that
rejects any Cancun opcode. Deployment uses ERC1967 proxies wired through `OstiumRegistry`.

**Tech Stack:** Foundry (forge/cast/anvil), Solidity 0.8.24, OpenZeppelin Contracts v5 +
Contracts-Upgradeable v5, Node 22 (`node:test`, no test-runner dependency), pnpm workspaces.

## Global Constraints

Every task's requirements implicitly include this section. Values are copied verbatim from
`docs/superpowers/specs/2026-09-08-whitechain-perp-dex-design.md`.

- Solidity compiler pinned to exactly **`0.8.24`**. Never a caret range.
- **`evm_version = "shanghai"`**. Never `cancun`, never `paris`.
- Emitted bytecode must contain **no `TLOAD` (0x5c), `TSTORE` (0x5d), or `MCOPY` (0x5e)**.
- All automated transactions are **legacy type 0**.
- **No dependency on Permit2** and none on the CREATE2 deployer for address derivation.
- Contracts must deploy to **both chain 1874 and chain 2625**.
- Upstream pinned at commit **`8390ce497f68fb128900840e0ec30683afa945d3`**
  (`0xOstium/smart-contracts-public`, tag v1.5.0, 2026-05-07).
- Upstream license is **MIT**. Preserve every `SPDX-License-Identifier` header and the upstream
  `LICENSE` file.
- Network endpoints:
  | Chain | id | RPC |
  |---|---|---|
  | Whitechain testnet (OP Stack) | `1874` | `https://rpc.testnet.whitechain.io` |
  | Whitechain testnet (legacy)   | `2625` | `https://rpc-testnet.whitechain.io` |
  | Whitechain mainnet            | `1875` | `https://rpc.whitechain.io` |
- Whitechain RPC nodes reject requests without a browser-like or curl-like `User-Agent`. Any
  HTTP client must set one explicitly or receive HTTP 403.

---

## File Structure

| Path | Responsibility |
|---|---|
| `package.json` | workspace root, scripts |
| `pnpm-workspace.yaml` | workspace member globs |
| `contracts/foundry.toml` | pinned solc, evm_version, metadata settings |
| `contracts/remappings.txt` | OZ and `src/` import resolution |
| `contracts/src/vendor/ostium/**` | upstream source, verbatim |
| `contracts/src/mocks/USDW.sol` | 6-decimal collateral token with faucet |
| `contracts/test/ChainUtils.t.sol` | pins block-number behaviour on our three chain ids |
| `contracts/test/USDW.t.sol` | faucet behaviour |
| `contracts/test/integration/DeployLocal.t.sol` | full-system deploy on anvil |
| `contracts/script/Deploy.s.sol` | proxy deployment + registry wiring |
| `contracts/script/config/<chainid>.json` | per-network deploy parameters |
| `contracts/VENDOR.md` | provenance: upstream commit, license, local modifications |
| `tools/evm-compat/scan.mjs` | bytecode disassembler, Cancun-opcode gate |
| `tools/evm-compat/scan.test.mjs` | unit tests for the disassembler |
| `tools/chain-probe/probe.mjs` | asserts measured network capabilities still hold |
| `tools/chain-probe/probe.test.mjs` | unit tests for the probe's pure helpers |
| `.github/workflows/ci.yml` | build, test, opcode gate, dual-network deploy check |

---

### Task 1: Foundry workspace with a pinned Shanghai toolchain

**Files:**
- Create: `package.json`
- Create: `pnpm-workspace.yaml`
- Create: `contracts/foundry.toml`
- Create: `contracts/remappings.txt`
- Create: `contracts/src/Probe.sol`
- Test: `contracts/test/Probe.t.sol`

**Interfaces:**
- Consumes: nothing.
- Produces: a working `forge build` / `forge test` in `contracts/`, with `solc 0.8.24` and
  `evm_version = shanghai` in effect. All later tasks depend on this toolchain.

- [ ] **Step 1: Install Foundry and OpenZeppelin dependencies**

```bash
curl -L https://foundry.paradigm.xyz | bash && foundryup
mkdir -p contracts && cd contracts
forge init --no-git --no-commit --force .
rm -f src/Counter.sol test/Counter.t.sol script/Counter.s.sol
forge install OpenZeppelin/openzeppelin-contracts@v5.0.2 --no-git
forge install OpenZeppelin/openzeppelin-contracts-upgradeable@v5.0.2 --no-git
```

- [ ] **Step 2: Write `contracts/foundry.toml`**

`bytecode_hash` and `cbor_metadata` are disabled deliberately: appended CBOR metadata is data,
not code, and would produce false positives in the Task 2 disassembler.

```toml
[profile.default]
src = "src"
out = "out"
libs = ["lib"]
test = "test"
script = "script"

solc_version = "0.8.24"
evm_version = "shanghai"
optimizer = true
optimizer_runs = 200
via_ir = false

bytecode_hash = "none"
cbor_metadata = false

fs_permissions = [{ access = "read", path = "./script/config" }]

[rpc_endpoints]
whitechain_testnet_op = "https://rpc.testnet.whitechain.io"
whitechain_testnet_legacy = "https://rpc-testnet.whitechain.io"
whitechain_mainnet = "https://rpc.whitechain.io"
```

- [ ] **Step 3: Write `contracts/remappings.txt`**

The `src/=src/` line is required: five upstream files import with a `src/`-rooted path
(for example `import 'src/interfaces/IOstiumRegistry.sol';`).

```
@openzeppelin/contracts/=lib/openzeppelin-contracts/contracts/
@openzeppelin/contracts-upgradeable/=lib/openzeppelin-contracts-upgradeable/contracts/
forge-std/=lib/forge-std/src/
src/=src/
```

- [ ] **Step 4: Write the failing test**

`contracts/test/Probe.t.sol`:

```solidity
// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {Probe} from "../src/Probe.sol";

contract ProbeTest is Test {
    Probe internal probe;

    function setUp() public {
        probe = new Probe();
    }

    function test_returnsBlockNumber() public {
        vm.roll(12345);
        assertEq(probe.currentBlock(), 12345);
    }
}
```

- [ ] **Step 5: Run the test to verify it fails**

```bash
cd contracts && forge test --match-path test/Probe.t.sol -vv
```

Expected: FAIL — `Probe.sol` does not exist, so compilation aborts with
`Source "src/Probe.sol" not found`.

- [ ] **Step 6: Write the minimal implementation**

`contracts/src/Probe.sol`:

```solidity
// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// @notice Smoke-test contract proving the pinned toolchain compiles and deploys.
contract Probe {
    function currentBlock() external view returns (uint256) {
        return block.number;
    }
}
```

- [ ] **Step 7: Run the test to verify it passes**

```bash
cd contracts && forge test --match-path test/Probe.t.sol -vv
```

Expected: PASS, 1 test.

- [ ] **Step 8: Assert the toolchain settings mechanically**

```bash
cd contracts
forge config --json | node -e '
const c = JSON.parse(require("fs").readFileSync(0, "utf8"));
const fail = (m) => { console.error("TOOLCHAIN GATE FAILED: " + m); process.exit(1); };
if (c.solc !== "0.8.24") fail(`solc is ${c.solc}, expected 0.8.24`);
if (c.evm_version !== "shanghai") fail(`evm_version is ${c.evm_version}, expected shanghai`);
if (c.bytecode_hash !== "none") fail(`bytecode_hash is ${c.bytecode_hash}, expected none`);
console.log("toolchain gate OK: solc 0.8.24 / shanghai / no metadata");
'
```

Expected: `toolchain gate OK: solc 0.8.24 / shanghai / no metadata`.

- [ ] **Step 9: Write the workspace manifests**

`package.json`:

```json
{
  "name": "whitespace",
  "private": true,
  "packageManager": "pnpm@9.12.0",
  "engines": { "node": ">=22" },
  "scripts": {
    "build:contracts": "cd contracts && forge build",
    "test:contracts": "cd contracts && forge test",
    "test:tools": "node --test tools/",
    "gate:evm": "node tools/evm-compat/scan.mjs contracts/out",
    "gate:toolchain": "cd contracts && forge config --json > /tmp/fc.json && node ../tools/evm-compat/toolchain.mjs /tmp/fc.json"
  }
}
```

`pnpm-workspace.yaml`:

```yaml
packages:
  - "packages/*"
  - "services/*"
  - "apps/*"
```

- [ ] **Step 10: Commit**

```bash
git add package.json pnpm-workspace.yaml contracts/foundry.toml contracts/remappings.txt \
        contracts/src/Probe.sol contracts/test/Probe.t.sol contracts/lib contracts/.gitignore
git commit -m "chore: pin foundry toolchain to solc 0.8.24 shanghai"
```

---

### Task 2: Cancun-opcode gate

**Files:**
- Create: `tools/evm-compat/scan.mjs`
- Create: `tools/evm-compat/toolchain.mjs`
- Test: `tools/evm-compat/scan.test.mjs`

**Interfaces:**
- Consumes: `contracts/out/**/*.json` artifacts produced by Task 1's `forge build`.
- Produces: `scanBytecode(hex) -> Array<{offset:number, opcode:string}>` exported from
  `tools/evm-compat/scan.mjs`; a CLI that exits 1 when any artifact contains a forbidden opcode.
  Task 10 (CI) calls this CLI.

- [ ] **Step 1: Write the failing test**

The disassembler must skip `PUSH1`–`PUSH32` immediate data. A naive byte search reports a
`0x5d` inside `PUSH2 0x5d5d` as `TSTORE`; that is the bug this test exists to prevent.

`tools/evm-compat/scan.test.mjs`:

```javascript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scanBytecode } from './scan.mjs';

test('accepts bytecode with no Cancun opcodes', () => {
  // PUSH1 0x01, PUSH1 0x00, MSTORE, STOP
  assert.deepEqual(scanBytecode('0x600160005200'), []);
});

test('accepts PUSH0, which is Shanghai and allowed', () => {
  // PUSH0, POP, STOP
  assert.deepEqual(scanBytecode('0x5f5000'), []);
});

test('detects a real TSTORE', () => {
  // PUSH1 0x00, PUSH1 0x00, TSTORE
  assert.deepEqual(scanBytecode('0x600060005d'), [{ offset: 4, opcode: 'TSTORE' }]);
});

test('detects TLOAD and MCOPY', () => {
  assert.deepEqual(scanBytecode('0x5c'), [{ offset: 0, opcode: 'TLOAD' }]);
  assert.deepEqual(scanBytecode('0x5e'), [{ offset: 0, opcode: 'MCOPY' }]);
});

test('does NOT report forbidden bytes inside PUSH immediates', () => {
  // PUSH2 0x5d5d  -> the two 0x5d bytes are data, not opcodes
  assert.deepEqual(scanBytecode('0x615d5d'), []);
});

test('does NOT report a forbidden byte inside PUSH32 immediate data', () => {
  const immediate = '5c'.repeat(32);
  assert.deepEqual(scanBytecode('0x7f' + immediate), []);
});

test('handles a truncated trailing PUSH without throwing', () => {
  // PUSH32 with only one immediate byte present
  assert.deepEqual(scanBytecode('0x7f5c'), []);
});

test('tolerates empty and 0x-only input', () => {
  assert.deepEqual(scanBytecode('0x'), []);
  assert.deepEqual(scanBytecode(''), []);
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
node --test tools/evm-compat/
```

Expected: FAIL — `Cannot find module '.../tools/evm-compat/scan.mjs'`.

- [ ] **Step 3: Write the implementation**

`tools/evm-compat/scan.mjs`:

```javascript
#!/usr/bin/env node
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const FORBIDDEN = { 0x5c: 'TLOAD', 0x5d: 'TSTORE', 0x5e: 'MCOPY' };
const PUSH1 = 0x60;
const PUSH32 = 0x7f;

/**
 * Linear-sweep disassembly that skips PUSH immediate data.
 * @param {string} hex bytecode, with or without a leading 0x
 * @returns {Array<{offset:number, opcode:string}>}
 */
export function scanBytecode(hex) {
  const clean = String(hex ?? '').replace(/^0x/i, '');
  if (clean.length === 0) return [];
  const code = Buffer.from(clean, 'hex');
  const found = [];
  let i = 0;
  while (i < code.length) {
    const op = code[i];
    if (FORBIDDEN[op] !== undefined) found.push({ offset: i, opcode: FORBIDDEN[op] });
    i += op >= PUSH1 && op <= PUSH32 ? 1 + (op - PUSH1 + 1) : 1;
  }
  return found;
}

function* walkJson(dir) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) yield* walkJson(full);
    else if (entry.endsWith('.json')) yield full;
  }
}

function main() {
  const dir = process.argv[2];
  if (!dir) {
    console.error('usage: scan.mjs <forge-out-dir>');
    process.exit(2);
  }
  let scanned = 0;
  const violations = [];
  for (const file of walkJson(dir)) {
    let artifact;
    try {
      artifact = JSON.parse(readFileSync(file, 'utf8'));
    } catch {
      continue;
    }
    for (const key of ['bytecode', 'deployedBytecode']) {
      const object = artifact?.[key]?.object;
      if (typeof object !== 'string' || object.length <= 2) continue;
      scanned += 1;
      for (const hit of scanBytecode(object)) {
        violations.push(`${file} [${key}] offset ${hit.offset}: ${hit.opcode}`);
      }
    }
  }
  if (violations.length > 0) {
    console.error('EVM COMPAT GATE FAILED — Cancun opcodes found:');
    for (const v of violations) console.error('  ' + v);
    console.error('\nWhitechain mainnet 1875 does not implement these. Check evm_version.');
    process.exit(1);
  }
  console.log(`evm compat gate OK: ${scanned} bytecode objects, no Cancun opcodes`);
}

if (import.meta.url === `file://${process.argv[1]}`) main();
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
node --test tools/evm-compat/
```

Expected: PASS, 8 tests.

- [ ] **Step 5: Write the toolchain assertion as a reusable script**

`tools/evm-compat/toolchain.mjs`:

```javascript
#!/usr/bin/env node
import { readFileSync } from 'node:fs';

const EXPECTED = { solc: '0.8.24', evm_version: 'shanghai', bytecode_hash: 'none' };

const path = process.argv[2];
if (!path) {
  console.error('usage: toolchain.mjs <forge-config-json>');
  process.exit(2);
}
const config = JSON.parse(readFileSync(path, 'utf8'));
const problems = [];
for (const [key, want] of Object.entries(EXPECTED)) {
  if (config[key] !== want) problems.push(`${key} is ${config[key]}, expected ${want}`);
}
if (problems.length > 0) {
  console.error('TOOLCHAIN GATE FAILED:');
  for (const p of problems) console.error('  ' + p);
  process.exit(1);
}
console.log('toolchain gate OK: solc 0.8.24 / shanghai / no metadata');
```

- [ ] **Step 6: Run both gates against the real build**

```bash
cd contracts && forge build && forge config --json > /tmp/fc.json && cd ..
node tools/evm-compat/toolchain.mjs /tmp/fc.json
node tools/evm-compat/scan.mjs contracts/out
```

Expected: both print `... gate OK`.

- [ ] **Step 7: Commit**

```bash
git add tools/evm-compat/
git commit -m "feat: add Cancun opcode and toolchain compatibility gates"
```

---

### Task 3: Network registry and live capability probe

**Files:**
- Create: `packages/shared/package.json`
- Create: `packages/shared/src/chains.mjs`
- Create: `tools/chain-probe/probe.mjs`
- Test: `tools/chain-probe/probe.test.mjs`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `CHAINS` (an object keyed by chain id) exported from `packages/shared/src/chains.mjs`,
  each entry `{ id, name, rpc, expects: { eip1559, cancun, create2Factory, multicall3 } }`;
  and `classifyProbe(results, expects) -> Array<string>` exported from
  `tools/chain-probe/probe.mjs`. Tasks 4, 9 and 10 consume `CHAINS`.

- [ ] **Step 1: Write the chain registry**

Values are the measurements recorded in spec §2.1.

`packages/shared/src/chains.mjs`:

```javascript
export const CHAINS = {
  1874: {
    id: 1874,
    name: 'whitechain-testnet-op',
    rpc: 'https://rpc.testnet.whitechain.io',
    expects: { eip1559: true, cancun: true, create2Factory: true, multicall3: true },
  },
  2625: {
    id: 2625,
    name: 'whitechain-testnet-legacy',
    rpc: 'https://rpc-testnet.whitechain.io',
    expects: { eip1559: false, cancun: false, create2Factory: false, multicall3: false },
  },
  1875: {
    id: 1875,
    name: 'whitechain-mainnet',
    rpc: 'https://rpc.whitechain.io',
    expects: { eip1559: false, cancun: false, create2Factory: false, multicall3: true },
  },
};
```

`packages/shared/package.json`:

```json
{
  "name": "@whitespace/shared",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "main": "src/chains.mjs",
  "exports": { ".": "./src/chains.mjs" }
}
```

- [ ] **Step 2: Write the failing test**

`tools/chain-probe/probe.test.mjs`:

```javascript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyProbe } from './probe.mjs';
import { CHAINS } from '../../packages/shared/src/chains.mjs';

test('reports no drift when observations match expectations', () => {
  const observed = { eip1559: false, cancun: false, create2Factory: false, multicall3: true };
  assert.deepEqual(classifyProbe(observed, CHAINS[1875].expects), []);
});

test('reports drift when mainnet gains Cancun', () => {
  const observed = { eip1559: false, cancun: true, create2Factory: false, multicall3: true };
  assert.deepEqual(classifyProbe(observed, CHAINS[1875].expects), [
    'cancun: expected false, observed true',
  ]);
});

test('reports every drifted field', () => {
  const observed = { eip1559: true, cancun: true, create2Factory: false, multicall3: true };
  assert.deepEqual(classifyProbe(observed, CHAINS[2625].expects), [
    'eip1559: expected false, observed true',
    'cancun: expected false, observed true',
    'multicall3: expected false, observed true',
  ]);
});

test('chain registry covers exactly the three known networks', () => {
  assert.deepEqual(Object.keys(CHAINS).sort(), ['1874', '1875', '2625']);
});
```

- [ ] **Step 3: Run the test to verify it fails**

```bash
node --test tools/chain-probe/
```

Expected: FAIL — `Cannot find module '.../tools/chain-probe/probe.mjs'`.

- [ ] **Step 4: Write the implementation**

The `User-Agent` header is mandatory: the Whitechain nodes return HTTP 403 to clients that omit
a browser-like or curl-like value.

`tools/chain-probe/probe.mjs`:

```javascript
#!/usr/bin/env node
import { CHAINS } from '../../packages/shared/src/chains.mjs';

const MULTICALL3 = '0xcA11bde05977b3631167028862bE2a173976CA11';
const CREATE2_FACTORY = '0x4e59b44847b379578588920cA78FbF26c0B4956C';

// init code that executes one opcode then returns a single byte
const PROBE_MCOPY = '0x60006000600060005e600160005260016000f3';

/** @returns {string[]} human-readable drift descriptions, empty when all match */
export function classifyProbe(observed, expects) {
  const drift = [];
  for (const [key, want] of Object.entries(expects)) {
    const got = observed[key];
    if (got !== want) drift.push(`${key}: expected ${want}, observed ${got}`);
  }
  return drift;
}

async function rpc(url, method, params) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'User-Agent': 'curl/8.5.0' },
    body: JSON.stringify({ jsonrpc: '2.0', method, params, id: 1 }),
  });
  if (!res.ok) throw new Error(`${method} -> HTTP ${res.status}`);
  return res.json();
}

async function hasCode(url, address) {
  const { result } = await rpc(url, 'eth_getCode', [address, 'latest']);
  return typeof result === 'string' && result !== '0x';
}

async function observe(chain) {
  const block = (await rpc(chain.rpc, 'eth_getBlockByNumber', ['latest', false])).result;
  const mcopy = await rpc(chain.rpc, 'eth_call', [{ data: PROBE_MCOPY }, 'latest']);
  return {
    eip1559: block?.baseFeePerGas != null,
    cancun: mcopy.error === undefined,
    create2Factory: await hasCode(chain.rpc, CREATE2_FACTORY),
    multicall3: await hasCode(chain.rpc, MULTICALL3),
  };
}

async function main() {
  let failed = false;
  for (const chain of Object.values(CHAINS)) {
    let observed;
    try {
      observed = await observe(chain);
    } catch (err) {
      console.error(`${chain.name} (${chain.id}): UNREACHABLE — ${err.message}`);
      failed = true;
      continue;
    }
    const drift = classifyProbe(observed, chain.expects);
    if (drift.length === 0) {
      console.log(`${chain.name} (${chain.id}): OK`);
    } else {
      console.error(`${chain.name} (${chain.id}): DRIFT`);
      for (const d of drift) console.error('  ' + d);
      failed = true;
    }
  }
  if (failed) {
    console.error('\nNetwork capabilities differ from the spec. Update spec §2.1 deliberately.');
    process.exit(1);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) main();
```

- [ ] **Step 5: Run the test to verify it passes**

```bash
node --test tools/chain-probe/
```

Expected: PASS, 4 tests.

- [ ] **Step 6: Run the probe against the live networks**

```bash
node tools/chain-probe/probe.mjs
```

Expected: three `OK` lines. If any line reports DRIFT, stop and report it — the spec's
measurements are stale and downstream decisions may no longer hold.

- [ ] **Step 7: Commit**

```bash
git add packages/shared tools/chain-probe/
git commit -m "feat: add chain registry and capability drift probe"
```

---

### Task 4: Resolve the pre-EIP-155 question on mainnet

Spec §12 item 2 is an open question: whether mainnet 1875 accepts pre-EIP-155 (chain-id-less)
transactions, which determines whether the canonical CREATE2 factory can ever be deployed there.
This task answers it without spending funds.

**Files:**
- Create: `tools/chain-probe/pre155.mjs`
- Modify: `docs/superpowers/specs/2026-09-08-whitechain-perp-dex-design.md` (§12 item 2)

**Interfaces:**
- Consumes: `CHAINS` from `packages/shared/src/chains.mjs`.
- Produces: a documented yes/no answer in the spec. No code consumed by later tasks.

- [ ] **Step 1: Write the probe**

The canonical CREATE2 factory is deployed by a well-known pre-signed transaction. Submitting a
malformed copy is enough to learn whether the node's transaction pool accepts unprotected
(pre-EIP-155) signatures: a node with `AllowUnprotectedTxs = false` rejects with a distinctive
message before any balance or nonce check.

`tools/chain-probe/pre155.mjs`:

```javascript
#!/usr/bin/env node
import { CHAINS } from '../../packages/shared/src/chains.mjs';

// The canonical Arachnid CREATE2 deployer presigned transaction (v=27, no chain id).
const PRESIGNED =
  '0xf8a58085174876e800830186a08080b853604580600e600039806000f350fe7fffffff' +
   'ffffffffffffffffffffffffffffffffffffffffffffffffffffffffff30818152602081' +
  '52f31ba02222222222222222222222222222222222222222222222222222222222222222' +
  'a02222222222222222222222222222222222222222222222222222222222222222';

async function main() {
  const chain = CHAINS[1875];
  const res = await fetch(chain.rpc, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'User-Agent': 'curl/8.5.0' },
    body: JSON.stringify({
      jsonrpc: '2.0', method: 'eth_sendRawTransaction', params: [PRESIGNED], id: 1,
    }),
  });
  const body = await res.json();
  const message = body?.error?.message ?? '(no error — transaction was accepted)';
  console.log(`chain ${chain.id} response: ${message}`);
  console.log('');
  console.log('Interpretation:');
  console.log('  "only replay-protected (EIP-155) transactions allowed"');
  console.log('      -> pre-EIP-155 REJECTED. The canonical CREATE2 factory can never be');
  console.log('         deployed at 0x4e59...; deterministic addresses are unavailable.');
  console.log('  "insufficient funds" / "invalid sender" / "nonce too low"');
  console.log('      -> pre-EIP-155 ACCEPTED by the pool. The factory is deployable by');
  console.log('         funding the deployer address and submitting the real presigned tx.');
}

main();
```

- [ ] **Step 2: Run it**

```bash
node tools/chain-probe/pre155.mjs
```

Expected: one response line plus the interpretation guide. Record the exact response text.

- [ ] **Step 3: Record the answer in the spec**

Replace item 2 of `## 12. Not verified / open questions` with the finding. Use this shape,
substituting the observed response and the matching conclusion:

```markdown
2. ~~Whether mainnet 1875 accepts pre-EIP-155 transactions~~ **Answered 2026-09-08.**
   `eth_sendRawTransaction` with an unprotected signature returned: `<exact response text>`.
   Conclusion: pre-EIP-155 transactions are **<accepted|rejected>**, therefore the canonical
   CREATE2 factory at `0x4e59b448…` **<can|cannot>** be deployed on mainnet. Consequence for
   the design: <deterministic cross-chain addresses are available|address derivation must not
   assume CREATE2, as already required by the Global Constraints>.
```

- [ ] **Step 4: Commit**

```bash
git add tools/chain-probe/pre155.mjs docs/superpowers/specs/2026-09-08-whitechain-perp-dex-design.md
git commit -m "docs: resolve pre-EIP-155 question for mainnet CREATE2"
```

---

### Task 5: Vendor the Ostium contracts with provenance

**Files:**
- Create: `contracts/src/vendor/ostium/**` (46 `.sol` files, verbatim)
- Create: `contracts/src/vendor/ostium/LICENSE`
- Create: `contracts/VENDOR.md`
- Modify: `contracts/remappings.txt`

**Interfaces:**
- Consumes: the Task 1 toolchain.
- Produces: all upstream contracts compiling under Shanghai. Tasks 6, 8 and 9 import from
  `src/vendor/ostium/`. Registry key names, exported by upstream and relied on by Task 8:
  `pairsStorage`, `pairInfos`, `tradingStorage`, `trading`, `callbacks`, `vault`, `openPnl`,
  `priceRouter`, `ostiumVerifier`, `lockedDepositNft`, `chainlinkVerifierProxy`.

- [ ] **Step 1: Vendor the source at the pinned commit**

```bash
cd /tmp && rm -rf ostium-upstream
git clone https://github.com/0xOstium/smart-contracts-public.git ostium-upstream
cd ostium-upstream && git checkout 8390ce497f68fb128900840e0ec30683afa945d3
cd /home/oleksandr/Documents/whitespace
mkdir -p contracts/src/vendor/ostium
cp -R /tmp/ostium-upstream/src/. contracts/src/vendor/ostium/
cp /tmp/ostium-upstream/LICENSE contracts/src/vendor/ostium/LICENSE
find contracts/src/vendor/ostium -name '*.sol' | wc -l   # expect 46
```

- [ ] **Step 2: Extend remappings for the vendored path**

Five upstream files import with a `src/`-rooted path. Add a line so those resolve to the
vendored tree rather than to `contracts/src/`.

Append to `contracts/remappings.txt`:

```
src/interfaces/=src/vendor/ostium/interfaces/
src/lib/=src/vendor/ostium/lib/
src/abstract/=src/vendor/ostium/abstract/
```

- [ ] **Step 3: Build and verify it compiles under Shanghai**

```bash
cd contracts && forge build
```

Expected: `Compiler run successful`. If it fails on unresolved imports, list the failures and
add the corresponding remapping — do **not** edit vendored source in this phase.

- [ ] **Step 4: Run the compatibility gate over the real contracts**

```bash
cd .. && node tools/evm-compat/scan.mjs contracts/out
```

Expected: `evm compat gate OK: <n> bytecode objects, no Cancun opcodes`. This is the first
real proof that the Ostium contracts can run on Whitechain mainnet.

- [ ] **Step 5: Write the provenance record**

`contracts/VENDOR.md`:

```markdown
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
```

- [ ] **Step 6: Commit**

```bash
git add contracts/src/vendor contracts/VENDOR.md contracts/remappings.txt
git commit -m "feat: vendor Ostium V2 contracts at pinned commit"
```

---

### Task 6: Pin ChainUtils behaviour on our three chain ids

The design decision is to leave `ChainUtils` unmodified. That decision is only safe if it is
tested — otherwise an upstream bump could silently change block-number semantics.

**Files:**
- Create: `contracts/test/ChainUtils.t.sol`

**Interfaces:**
- Consumes: `src/vendor/ostium/lib/ChainUtils.sol`.
- Produces: nothing consumed by later tasks; a regression guard only.

- [ ] **Step 1: Write the failing test**

`ChainUtils` is an `internal` library, so it needs a harness contract to be callable from tests.

`contracts/test/ChainUtils.t.sol`:

```solidity
// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {ChainUtils} from "../src/vendor/ostium/lib/ChainUtils.sol";

contract ChainUtilsHarness {
    function blockNumber() external view returns (uint256) {
        return ChainUtils.getBlockNumber();
    }
}

contract ChainUtilsTest is Test {
    ChainUtilsHarness internal harness;

    function setUp() public {
        harness = new ChainUtilsHarness();
    }

    function test_returnsBlockNumberOnWhitechainTestnetOp() public {
        vm.chainId(1874);
        vm.roll(777);
        assertEq(harness.blockNumber(), 777);
    }

    function test_returnsBlockNumberOnWhitechainTestnetLegacy() public {
        vm.chainId(2625);
        vm.roll(888);
        assertEq(harness.blockNumber(), 888);
    }

    function test_returnsBlockNumberOnWhitechainMainnet() public {
        vm.chainId(1875);
        vm.roll(999);
        assertEq(harness.blockNumber(), 999);
    }

    /// @dev The Arbitrum branch is unreachable on our chain ids, so `block.number` is the
    ///      only path taken. This fuzz test covers the whole non-Arbitrum chain-id space,
    ///      which is what makes keeping the vendored library unmodified safe.
    function testFuzz_returnsBlockNumberForAnyNonArbitrumChain(uint64 chainId, uint32 height)
        public
    {
        vm.assume(chainId != 42161 && chainId != 421613 && chainId != 421614);
        vm.assume(chainId != 0);
        vm.chainId(chainId);
        vm.roll(height);
        assertEq(harness.blockNumber(), height);
    }
}
```

- [ ] **Step 2: Run the test to verify it passes**

This test documents existing behaviour rather than driving new code, so it passes immediately.
That is expected and correct for a regression guard on vendored source.

```bash
cd contracts && forge test --match-path test/ChainUtils.t.sol -vv
```

Expected: PASS, 4 tests (3 unit + 1 fuzz).

- [ ] **Step 3: Prove the test would catch a regression**

Temporarily add `1874` to the Arbitrum branch condition in
`src/vendor/ostium/lib/ChainUtils.sol`, re-run, confirm failure, then revert.

```bash
cd contracts
sed -i 's/block.chainid == ARBITRUM_MAINNET/block.chainid == 1874 || block.chainid == ARBITRUM_MAINNET/' \
  src/vendor/ostium/lib/ChainUtils.sol
forge test --match-path test/ChainUtils.t.sol   # expect FAIL on the 1874 case
git checkout src/vendor/ostium/lib/ChainUtils.sol
forge test --match-path test/ChainUtils.t.sol   # expect PASS again
```

Expected: FAIL then PASS. A regression guard that cannot fail is worthless; this step proves
it can.

- [ ] **Step 4: Commit**

```bash
git add contracts/test/ChainUtils.t.sol
git commit -m "test: pin ChainUtils block-number behaviour on Whitechain ids"
```

---

### Task 7: USDW collateral token

No stablecoin exists on Whitechain, so testnet needs a faucet-backed collateral asset with the
same decimals as the USDC that upstream expects.

**Files:**
- Create: `contracts/src/mocks/USDW.sol`
- Test: `contracts/test/USDW.t.sol`

**Interfaces:**
- Consumes: OpenZeppelin `ERC20`, `Ownable`.
- Produces: `USDW` with `decimals() == 6`, `claim()`, `mint(address,uint256)` (owner only),
  `FAUCET_AMOUNT` (`1_000e6`), `FAUCET_COOLDOWN` (`1 days`), `lastClaim(address)`.
  Task 8 passes its address to `OstiumTradingStorage.initialize(registry, usdc)`.

- [ ] **Step 1: Write the failing test**

`contracts/test/USDW.t.sol`:

```solidity
// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {USDW} from "../src/mocks/USDW.sol";

contract USDWTest is Test {
    USDW internal usd;
    address internal alice = address(0xA11CE);
    address internal owner = address(this);

    function setUp() public {
        usd = new USDW(owner);
    }

    function test_hasSixDecimals() public view {
        assertEq(usd.decimals(), 6);
    }

    function test_claimMintsFaucetAmount() public {
        vm.prank(alice);
        usd.claim();
        assertEq(usd.balanceOf(alice), usd.FAUCET_AMOUNT());
    }

    function test_secondClaimWithinCooldownReverts() public {
        vm.startPrank(alice);
        usd.claim();
        vm.expectRevert(abi.encodeWithSelector(USDW.CooldownActive.selector, block.timestamp + 1 days));
        usd.claim();
        vm.stopPrank();
    }

    function test_claimSucceedsAfterCooldown() public {
        vm.startPrank(alice);
        usd.claim();
        vm.warp(block.timestamp + 1 days);
        usd.claim();
        vm.stopPrank();
        assertEq(usd.balanceOf(alice), 2 * usd.FAUCET_AMOUNT());
    }

    function test_ownerCanMint() public {
        usd.mint(alice, 500e6);
        assertEq(usd.balanceOf(alice), 500e6);
    }

    function test_nonOwnerCannotMint() public {
        vm.prank(alice);
        vm.expectRevert();
        usd.mint(alice, 1);
    }
}
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd contracts && forge test --match-path test/USDW.t.sol -vv
```

Expected: FAIL — `Source "src/mocks/USDW.sol" not found`.

- [ ] **Step 3: Write the implementation**

`contracts/src/mocks/USDW.sol`:

```solidity
// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

/// @notice Testnet-only collateral asset. Six decimals to match the USDC that the
///         vendored Ostium contracts expect. Never deploy this to mainnet.
contract USDW is ERC20, Ownable {
    uint256 public constant FAUCET_AMOUNT = 1_000e6;
    uint256 public constant FAUCET_COOLDOWN = 1 days;

    mapping(address => uint256) public lastClaim;

    error CooldownActive(uint256 availableAt);

    constructor(address initialOwner) ERC20("Whitespace USD", "USDW") Ownable(initialOwner) {}

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    /// @notice Mint the faucet amount to the caller, at most once per cooldown period.
    function claim() external {
        uint256 previous = lastClaim[msg.sender];
        if (previous != 0 && block.timestamp < previous + FAUCET_COOLDOWN) {
            revert CooldownActive(previous + FAUCET_COOLDOWN);
        }
        lastClaim[msg.sender] = block.timestamp;
        _mint(msg.sender, FAUCET_AMOUNT);
    }

    /// @notice Owner mint, for seeding the LP vault and test accounts.
    function mint(address to, uint256 amount) external onlyOwner {
        _mint(to, amount);
    }
}
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
cd contracts && forge test --match-path test/USDW.t.sol -vv
```

Expected: PASS, 6 tests.

- [ ] **Step 5: Commit**

```bash
git add contracts/src/mocks/USDW.sol contracts/test/USDW.t.sol
git commit -m "feat: add USDW faucet collateral token"
```

---

### Task 8: Deployment script and local integration test

**Files:**
- Create: `contracts/script/Deploy.s.sol`
- Create: `contracts/script/config/1874.json`
- Create: `contracts/script/config/2625.json`
- Test: `contracts/test/integration/DeployLocal.t.sol`

**Interfaces:**
- Consumes: `USDW` (Task 7); vendored contracts and registry key names (Task 5).
- Produces: `DeployScript.deployAll(Roles memory) -> Deployment` and `DeployScript.run()`, where
  `struct Roles { address gov; address dev; address manager; address owner; address marketMaker; }`
  and
  `struct Deployment { address registry; address collateral; address tradingStorage; address pairsStorage; address pairInfos; address trading; address callbacks; address vault; address openPnl; address priceRouter; address verifier; address priceUpKeep; }`.
  Task 9 executes this script against live networks.

**Two upstream facts drive this task's shape.** Both were verified by reading the vendored
source, and both break the obvious naive deployment:

1. **`OstiumRegistry` requires four mutually distinct addresses.** Its constructor is
   `constructor(address _gov, address _dev, address _manager, address owner)`, and `setGov`,
   `setDev` and `setManager` each revert with `HasAlreadyRole` when the incoming address equals
   any already-assigned role or `owner()`. Deploying with one address for everything reverts.
2. **A fresh deployment must replay the upstream migration chain.** Upstream evolved a *live*
   system, so state lives in `reinitializer(n)` functions as well as in `initialize`:
   `OstiumVault` → V2, V3, V4; `OstiumPairInfos` → V2, V3, V4; `OstiumPairsStorage` → V2;
   `OstiumOpenPnl` → V2. OpenZeppelin's `reinitializer(n)` only requires `_initialized < n`, so
   calling V4 directly would succeed and permanently skip V2 and V3 — leaving their state unset.
   They must be called **in ascending order**. For a greenfield deployment with no markets yet,
   the array arguments are empty.

- [ ] **Step 1: Write the failing integration test**

Upstream contracts resolve their peers lazily through `registry.getContractAddress(name)`, so
the deployment order is: registry → implementations behind proxies → register. `registerContract`
carries an `isContract` modifier, so every registered address must already hold code.

`contracts/test/integration/DeployLocal.t.sol`:

```solidity
// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {DeployScript} from "../../script/Deploy.s.sol";
import {IOstiumRegistry} from "../../src/vendor/ostium/interfaces/IOstiumRegistry.sol";

contract DeployLocalTest is Test {
    DeployScript internal deployer;
    DeployScript.Deployment internal d;

    // Four mutually distinct addresses: OstiumRegistry rejects any collision.
    address internal gov = address(0x60F);
    address internal dev = address(0xDE7);
    address internal manager = address(0xA11);
    address internal marketMaker = address(0x33D);

    function setUp() public {
        deployer = new DeployScript();
        d = deployer.deployAll(
            DeployScript.Roles({
                gov: gov,
                dev: dev,
                manager: manager,
                owner: address(this),
                marketMaker: marketMaker
            })
        );
    }

    function test_rolesAreDistinctAndAssigned() public view {
        IOstiumRegistry registry = IOstiumRegistry(d.registry);
        assertEq(registry.gov(), gov);
        assertEq(registry.dev(), dev);
        assertEq(registry.manager(), manager);
    }

    /// @dev Guards the migration-chain replay: if any reinitializer were skipped,
    ///      the stored version would be lower than the highest one upstream defines.
    function test_migrationChainFullyReplayed() public view {
        assertEq(_initializedVersion(d.vault), 4);
        assertEq(_initializedVersion(d.pairInfos), 4);
        assertEq(_initializedVersion(d.pairsStorage), 2);
        assertEq(_initializedVersion(d.openPnl), 2);
    }

    /// @dev OZ v5 stores `_initialized` (uint64) in the first slot of the
    ///      InitializableStorage namespace.
    function _initializedVersion(address proxy) internal view returns (uint64) {
        bytes32 slot = 0xf0c57e16840df040f15088dc2f81fe391c3923bec73e23a9662efc9c229c6a00;
        return uint64(uint256(vm.load(proxy, slot)));
    }

    function test_registryKnowsEveryComponent() public view {
        IOstiumRegistry registry = IOstiumRegistry(d.registry);
        assertEq(registry.getContractAddress("tradingStorage"), d.tradingStorage);
        assertEq(registry.getContractAddress("pairsStorage"), d.pairsStorage);
        assertEq(registry.getContractAddress("pairInfos"), d.pairInfos);
        assertEq(registry.getContractAddress("trading"), d.trading);
        assertEq(registry.getContractAddress("callbacks"), d.callbacks);
        assertEq(registry.getContractAddress("vault"), d.vault);
        assertEq(registry.getContractAddress("openPnl"), d.openPnl);
        assertEq(registry.getContractAddress("priceRouter"), d.priceRouter);
        assertEq(registry.getContractAddress("ostiumVerifier"), d.verifier);
    }

    function test_everyComponentHasCode() public view {
        address[9] memory all = [
            d.registry, d.tradingStorage, d.pairsStorage, d.pairInfos,
            d.trading, d.callbacks, d.vault, d.openPnl, d.priceRouter
        ];
        for (uint256 i = 0; i < all.length; i++) {
            assertGt(all[i].code.length, 0);
        }
    }

    function test_collateralIsSixDecimals() public view {
        (bool ok, bytes memory ret) = d.collateral.staticcall(abi.encodeWithSignature("decimals()"));
        assertTrue(ok);
        assertEq(abi.decode(ret, (uint8)), 6);
    }

    /// @dev `OstiumVault.initialize(address _asset, address _registry, ...)` takes two
    ///      same-typed addresses in a row. Swapping them compiles and deploys cleanly,
    ///      so only this assertion catches it.
    function test_vaultAssetIsCollateralNotRegistry() public view {
        (bool ok, bytes memory ret) = d.vault.staticcall(abi.encodeWithSignature("asset()"));
        assertTrue(ok);
        address asset = abi.decode(ret, (address));
        assertEq(asset, d.collateral);
        assertTrue(asset != d.registry);
    }
}
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd contracts && forge test --match-path test/integration/DeployLocal.t.sol -vv
```

Expected: FAIL — `Source "script/Deploy.s.sol" not found`.

- [ ] **Step 3: Write the deployment script**

Each upstream component is `Initializable`, so it goes behind an `ERC1967Proxy` whose
constructor calldata is the `initialize(...)` call. Constructor arguments for the initializers
were read from upstream and are reproduced here exactly.

`contracts/script/Deploy.s.sol`:

```solidity
// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Script} from "forge-std/Script.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";

import {USDW} from "../src/mocks/USDW.sol";
import {OstiumRegistry} from "../src/vendor/ostium/OstiumRegistry.sol";
import {OstiumVerifier} from "../src/vendor/ostium/OstiumVerifier.sol";
import {OstiumTradingStorage} from "../src/vendor/ostium/OstiumTradingStorage.sol";
import {OstiumPairsStorage} from "../src/vendor/ostium/OstiumPairsStorage.sol";
import {OstiumPairInfos} from "../src/vendor/ostium/OstiumPairInfos.sol";
import {OstiumTrading} from "../src/vendor/ostium/OstiumTrading.sol";
import {OstiumTradingCallbacks} from "../src/vendor/ostium/OstiumTradingCallbacks.sol";
import {OstiumVault} from "../src/vendor/ostium/OstiumVault.sol";
import {OstiumOpenPnl} from "../src/vendor/ostium/OstiumOpenPnl.sol";
import {OstiumPriceRouter} from "../src/vendor/ostium/OstiumPriceRouter.sol";
import {OstiumPrivatePriceUpKeep} from "../src/vendor/ostium/OstiumPrivatePriceUpKeep.sol";
import {IOstiumRegistry} from "../src/vendor/ostium/interfaces/IOstiumRegistry.sol";
import {IOstiumPairInfos} from "../src/vendor/ostium/interfaces/IOstiumPairInfos.sol";

contract DeployScript is Script {
    struct Deployment {
        address registry;
        address collateral;
        address tradingStorage;
        address pairsStorage;
        address pairInfos;
        address trading;
        address callbacks;
        address vault;
        address openPnl;
        address priceRouter;
        address verifier;
        address priceUpKeep;
    }

    struct Roles {
        address gov;
        address dev;
        address manager;
        address owner;
        address marketMaker;
    }

    // Initializer parameters. Values chosen for testnet; tune in phase 3.
    uint32 internal constant MAX_TS_VALIDITY = 60;          // seconds a price report stays usable
    uint256 internal constant FIRST_ORDER_ID = 1;
    uint256 internal constant LIQ_MARGIN_THRESHOLD_P = 25;  // upstream default
    uint256 internal constant MAX_NEGATIVE_PNL_ON_OPEN_P = 40;
    uint256 internal constant MAX_ALLOWED_COLLATERAL = 1_000_000e6;
    uint16 internal constant MARKET_ORDERS_TIMEOUT = 30;    // blocks
    uint16 internal constant TRIGGER_TIMEOUT = 30;          // blocks

    // OstiumVault.initialize parameters. Each bound below is enforced by the vault's
    // own require block; the values were chosen to satisfy it with headroom.
    uint256 internal constant MAX_ACC_OPEN_PNL_DELTA = 1e18;      // PRECISION_18
    uint256 internal constant MAX_DAILY_ACC_PNL_DELTA = 1e17;     // must be >= MIN 1e13
    uint16 internal constant MAX_SUPPLY_INCREASE_DAILY_P = 1000;  // 10%, must be <= 30000
    uint16 internal constant MAX_DISCOUNT_P = 1000;               // 10%, must be <= 5000
    uint16 internal constant MAX_DISCOUNT_THRESHOLD_P = 11000;    // 110%, must be > 10000
    int256 internal constant OPEN_ROLLOVER_FEE = 0;               // greenfield: no history

    function _proxy(address implementation, bytes memory initCall) internal returns (address) {
        return address(new ERC1967Proxy(implementation, initCall));
    }

    /// @notice Deploy the full system, wire the registry, and replay the migration chain.
    /// @param r Role assignments. `gov`, `dev`, `manager` and `owner` MUST be four distinct
    ///          addresses — OstiumRegistry reverts with `HasAlreadyRole` on any collision.
    function deployAll(Roles memory r) public returns (Deployment memory d) {
        require(
            r.gov != r.dev && r.gov != r.manager && r.gov != r.owner && r.dev != r.manager
                && r.dev != r.owner && r.manager != r.owner,
            "roles must be distinct"
        );

        // Registry takes all roles in its constructor and transfers ownership last.
        OstiumRegistry registry = new OstiumRegistry(r.gov, r.dev, r.manager, r.owner);
        d.registry = address(registry);
        IOstiumRegistry reg = IOstiumRegistry(d.registry);

        d.collateral = address(new USDW(r.owner));

        // Verifier is not upgradeable upstream: it takes the registry in its constructor.
        d.verifier = address(new OstiumVerifier(reg));

        d.tradingStorage = _proxy(
            address(new OstiumTradingStorage()),
            abi.encodeCall(OstiumTradingStorage.initialize, (reg, d.collateral))
        );
        d.pairsStorage = _proxy(
            address(new OstiumPairsStorage()),
            abi.encodeCall(OstiumPairsStorage.initialize, (reg))
        );
        d.pairInfos = _proxy(
            address(new OstiumPairInfos()),
            abi.encodeCall(
                OstiumPairInfos.initialize,
                (reg, r.manager, LIQ_MARGIN_THRESHOLD_P, MAX_NEGATIVE_PNL_ON_OPEN_P)
            )
        );
        d.callbacks = _proxy(
            address(new OstiumTradingCallbacks()),
            abi.encodeCall(OstiumTradingCallbacks.initialize, (reg))
        );
        d.openPnl = _proxy(
            address(new OstiumOpenPnl()),
            abi.encodeCall(OstiumOpenPnl.initialize, (reg))
        );
        d.priceRouter = _proxy(
            address(new OstiumPriceRouter()),
            abi.encodeCall(
                OstiumPriceRouter.initialize, (reg, MAX_TS_VALIDITY, FIRST_ORDER_ID)
            )
        );
        d.priceUpKeep = _proxy(
            address(new OstiumPrivatePriceUpKeep()),
            abi.encodeCall(OstiumPrivatePriceUpKeep.initialize, (reg))
        );
        d.trading = _proxy(
            address(new OstiumTrading()),
            abi.encodeCall(
                OstiumTrading.initialize,
                (reg, MAX_ALLOWED_COLLATERAL, MARKET_ORDERS_TIMEOUT, TRIGGER_TIMEOUT)
            )
        );

        // Vault: note _asset comes FIRST and _registry second, and the parameter list
        // is eight items long. Verified against src/vendor/ostium/OstiumVault.sol:109.
        uint16[2] memory withdrawLockThresholdsP = [uint16(10), uint16(20)];
        d.vault = _proxy(
            address(new OstiumVault()),
            abi.encodeCall(
                OstiumVault.initialize,
                (
                    d.collateral,
                    d.registry,
                    MAX_ACC_OPEN_PNL_DELTA,
                    MAX_DAILY_ACC_PNL_DELTA,
                    MAX_SUPPLY_INCREASE_DAILY_P,
                    MAX_DISCOUNT_P,
                    MAX_DISCOUNT_THRESHOLD_P,
                    withdrawLockThresholdsP
                )
            )
        );

        bytes32[] memory names = new bytes32[](9);
        address[] memory addrs = new address[](9);
        names[0] = "tradingStorage";  addrs[0] = d.tradingStorage;
        names[1] = "pairsStorage";    addrs[1] = d.pairsStorage;
        names[2] = "pairInfos";       addrs[2] = d.pairInfos;
        names[3] = "trading";         addrs[3] = d.trading;
        names[4] = "callbacks";       addrs[4] = d.callbacks;
        names[5] = "vault";           addrs[5] = d.vault;
        names[6] = "openPnl";         addrs[6] = d.openPnl;
        names[7] = "priceRouter";     addrs[7] = d.priceRouter;
        names[8] = "ostiumVerifier";  addrs[8] = d.verifier;
        registry.registerContracts(names, addrs);

        _replayMigrations(d, r.marketMaker);
    }

    /// @dev Upstream evolved a live system, so part of its state is set only by
    ///      `reinitializer(n)` functions. OZ v5 requires `_initialized < n`, which means
    ///      calling V4 first would silently skip V2 and V3 forever. Call them in ascending
    ///      order. All array arguments are empty: a greenfield deployment has no markets.
    function _replayMigrations(Deployment memory d, address marketMaker) internal {
        uint16[] memory noPairs = new uint16[](0);
        uint32[] memory noLeverages = new uint32[](0);
        uint256[] memory noUints = new uint256[](0);
        int256[] memory noInts = new int256[](0);
        IOstiumPairInfos.PairFundingFeesV2[] memory noFees =
            new IOstiumPairInfos.PairFundingFeesV2[](0);

        OstiumPairsStorage(d.pairsStorage).initializeV2(noPairs, noLeverages);

        OstiumOpenPnl(d.openPnl).initializeV2(OPEN_ROLLOVER_FEE, noPairs, noUints, noUints);

        OstiumPairInfos(d.pairInfos).initializeV2(noFees);
        OstiumPairInfos(d.pairInfos).initializeV3(
            LIQ_MARGIN_THRESHOLD_P, MAX_NEGATIVE_PNL_ON_OPEN_P
        );
        OstiumPairInfos(d.pairInfos).initializeV4(noPairs, noInts, noUints);

        OstiumVault(d.vault).initializeV2();
        OstiumVault(d.vault).initializeV3();
        OstiumVault(d.vault).initializeV4(marketMaker);
    }

    function run() external returns (Deployment memory) {
        uint256 pk = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address owner = vm.addr(pk);
        vm.startBroadcast(pk);
        Deployment memory d = deployAll(
            Roles({
                gov: vm.envAddress("GOV_ADDRESS"),
                dev: vm.envAddress("DEV_ADDRESS"),
                manager: vm.envAddress("MANAGER_ADDRESS"),
                owner: owner,
                marketMaker: vm.envAddress("MARKET_MAKER_ADDRESS")
            })
        );
        vm.stopBroadcast();
        return d;
    }
}
```

- [ ] **Step 4: Let the compiler verify every initializer signature**

The script deliberately uses `abi.encodeCall` rather than `abi.encodeWithSignature`.
`abi.encodeCall` is **fully type-checked against the real function pointer**: a wrong argument
count, a wrong type, or a renamed function is a compile error, not a runtime revert on a live
network. So the build itself is the signature verification.

```bash
cd contracts && forge build
```

Expected: `Compiler run successful`. A failure here names the exact mismatched initializer —
fix the script to match the vendored source, which is the authority.

**The one thing the compiler cannot catch:** `OstiumVault.initialize` begins
`(address _asset, address _registry, …)`. Both are `address`, so swapping them still compiles
and still deploys — producing a vault whose asset is the registry. The Step 1 test asserts
`asset() == collateral` precisely to catch that class of error, which type-checking cannot.

- [ ] **Step 5: Run the integration test to verify it passes**

```bash
cd contracts && forge test --match-path test/integration/DeployLocal.t.sol -vvv
```

Expected: PASS, 6 tests — `test_registryKnowsEveryComponent`, `test_everyComponentHasCode`,
`test_collateralIsSixDecimals`, `test_vaultAssetIsCollateralNotRegistry`,
`test_rolesAreDistinctAndAssigned`, `test_migrationChainFullyReplayed`.

- [ ] **Step 6: Write per-network deployment configuration**

`contracts/script/config/1874.json`:

```json
{
  "chainId": 1874,
  "name": "whitechain-testnet-op",
  "rpc": "https://rpc.testnet.whitechain.io",
  "legacyTransactions": true,
  "deployUSDW": true
}
```

`contracts/script/config/2625.json`:

```json
{
  "chainId": 2625,
  "name": "whitechain-testnet-legacy",
  "rpc": "https://rpc-testnet.whitechain.io",
  "legacyTransactions": true,
  "deployUSDW": true
}
```

- [ ] **Step 7: Commit**

```bash
git add contracts/script contracts/test/integration
git commit -m "feat: add full-system deployment script with registry wiring"
```

---

### Task 9: Deploy to both Whitechain testnets

This is the phase gate: the deliverable of phases 0–1 is the same system live on both networks.

**Files:**
- Create: `deployments/1874.json`
- Create: `deployments/2625.json`
- Create: `docs/runbooks/deploy-testnet.md`

**Interfaces:**
- Consumes: `DeployScript.run()` (Task 8), `CHAINS` (Task 3).
- Produces: recorded addresses per network. Phase 2 (oracle hardening) and every later phase
  read `deployments/<chainid>.json`.

- [ ] **Step 1: Fund the deployer on both testnets**

`OstiumRegistry` rejects any collision between `gov`, `dev`, `manager` and `owner`, so generate
**five distinct addresses**. Only the owner/deployer needs gas at this stage.

```bash
for role in owner gov dev manager marketmaker; do
  echo "== $role"; cast wallet new
done
# Store every key outside the repository. Only the owner key is needed to deploy.
```

Obtain testnet gas for the address on chain 1874 and chain 2625 through the Whitechain faucet.
Verify with:

```bash
export DEPLOYER=<address>
cast balance $DEPLOYER --rpc-url https://rpc.testnet.whitechain.io
cast balance $DEPLOYER --rpc-url https://rpc-testnet.whitechain.io
```

Expected: both non-zero. If the faucet is unavailable, stop and report — this is a hard
external dependency, recorded as spec §12 item 7.

- [ ] **Step 2: Deploy to chain 1874**

`--legacy` is mandatory per the Global Constraints: the same command must work on 2625, which
has no EIP-1559.

```bash
cd contracts
export DEPLOYER_PRIVATE_KEY=<owner-key>
export GOV_ADDRESS=<gov-address>
export DEV_ADDRESS=<dev-address>
export MANAGER_ADDRESS=<manager-address>
export MARKET_MAKER_ADDRESS=<marketmaker-address>
forge script script/Deploy.s.sol:DeployScript \
  --rpc-url https://rpc.testnet.whitechain.io \
  --broadcast --legacy -vvv
```

Expected: `ONCHAIN EXECUTION COMPLETE & SUCCESSFUL`.

- [ ] **Step 3: Deploy to chain 2625**

```bash
forge script script/Deploy.s.sol:DeployScript \
  --rpc-url https://rpc-testnet.whitechain.io \
  --broadcast --legacy -vvv
```

Expected: `ONCHAIN EXECUTION COMPLETE & SUCCESSFUL`. A failure here that does not occur on 1874
is the portability gate doing its job — diagnose before proceeding.

- [ ] **Step 4: Record the addresses**

Write `deployments/1874.json` and `deployments/2625.json` from each run's broadcast output,
using this shape:

```json
{
  "chainId": 1874,
  "deployedAt": "2026-09-08T00:00:00Z",
  "commit": "<git rev-parse HEAD>",
  "contracts": {
    "registry": "0x...",
    "collateral": "0x...",
    "tradingStorage": "0x...",
    "pairsStorage": "0x...",
    "pairInfos": "0x...",
    "trading": "0x...",
    "callbacks": "0x...",
    "vault": "0x...",
    "openPnl": "0x...",
    "priceRouter": "0x...",
    "verifier": "0x...",
    "priceUpKeep": "0x..."
  }
}
```

- [ ] **Step 5: Verify the live deployment answers correctly**

Confirm the deployed system is the one running — not merely that a transaction succeeded.

```bash
REGISTRY=$(node -e "console.log(require('./deployments/1874.json').contracts.registry)")
RPC=https://rpc.testnet.whitechain.io
cast call $REGISTRY "getContractAddress(bytes32)(address)" \
  $(cast format-bytes32-string "trading") --rpc-url $RPC
cast call $REGISTRY "gov()(address)" --rpc-url $RPC

# The migration chain must have been replayed, not skipped.
VAULT=$(node -e "console.log(require('./deployments/1874.json').contracts.vault)")
cast storage $VAULT \
  0xf0c57e16840df040f15088dc2f81fe391c3923bec73e23a9662efc9c229c6a00 --rpc-url $RPC
cast call $VAULT "asset()(address)" --rpc-url $RPC
```

Expected: the `trading` address matches `deployments/1874.json`; `gov` equals `$GOV_ADDRESS`
(**not** the deployer); the vault's `_initialized` slot decodes to `4`; and `asset()` returns
the USDW address, not the registry. Repeat every check against 2625.

- [ ] **Step 6: Write the runbook**

`docs/runbooks/deploy-testnet.md` recording: prerequisites, the exact commands from steps 2–5,
where keys live, how to roll forward on a failed partial deployment, and the fact that
`--legacy` is required on both networks.

- [ ] **Step 7: Commit**

```bash
git add deployments docs/runbooks/deploy-testnet.md
git commit -m "feat: deploy contracts to Whitechain testnets 1874 and 2625"
```

---

### Task 10: CI gate

**Files:**
- Create: `.github/workflows/ci.yml`

**Interfaces:**
- Consumes: every gate and test suite from Tasks 1–8.
- Produces: an automated gate. No code consumed by later tasks.

- [ ] **Step 1: Write the workflow**

`.github/workflows/ci.yml`:

```yaml
name: CI

on:
  push:
    branches: [main]
  pull_request:

jobs:
  contracts:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with: { submodules: recursive }

      - uses: actions/setup-node@v4
        with: { node-version: '22' }

      - uses: foundry-rs/foundry-toolchain@v1

      - name: Build contracts
        run: cd contracts && forge build --sizes

      - name: Toolchain gate (solc 0.8.24 / shanghai / no metadata)
        run: |
          cd contracts && forge config --json > /tmp/forge-config.json
          cd .. && node tools/evm-compat/toolchain.mjs /tmp/forge-config.json

      - name: EVM compatibility gate (no Cancun opcodes)
        run: node tools/evm-compat/scan.mjs contracts/out

      - name: Contract tests
        run: cd contracts && forge test -vv

      - name: Tool tests
        run: node --test tools/

  network-drift:
    runs-on: ubuntu-latest
    continue-on-error: true
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: '22' }
      - name: Chain capability drift probe
        run: node tools/chain-probe/probe.mjs
```

`network-drift` is `continue-on-error: true` deliberately: it depends on third-party RPC
availability, so it must report drift without blocking merges on someone else's outage.

- [ ] **Step 2: Verify the workflow locally before pushing**

```bash
cd contracts && forge build --sizes && forge config --json > /tmp/forge-config.json && cd ..
node tools/evm-compat/toolchain.mjs /tmp/forge-config.json
node tools/evm-compat/scan.mjs contracts/out
cd contracts && forge test -vv && cd ..
node --test tools/
node tools/chain-probe/probe.mjs
```

Expected: every command exits 0.

- [ ] **Step 3: Prove the EVM gate actually blocks a bad build**

```bash
cd contracts
sed -i 's/evm_version = "shanghai"/evm_version = "cancun"/' foundry.toml
forge build && cd .. && node tools/evm-compat/toolchain.mjs <(cd contracts && forge config --json)
# expect: TOOLCHAIN GATE FAILED: evm_version is cancun, expected shanghai  (exit 1)
cd contracts && sed -i 's/evm_version = "cancun"/evm_version = "shanghai"/' foundry.toml
forge build && cd ..
node tools/evm-compat/toolchain.mjs <(cd contracts && forge config --json)   # expect OK
```

Expected: FAIL then OK. A gate never observed failing is not known to work.

- [ ] **Step 4: Commit**

```bash
git add .github/workflows/ci.yml
git commit -m "ci: gate builds on Shanghai-only bytecode and dual-network tests"
```

---

## Phase gate

Phases 0–1 are complete when all of these hold:

1. `forge test` passes.
2. `node tools/evm-compat/scan.mjs contracts/out` reports no Cancun opcodes.
3. `node tools/chain-probe/probe.mjs` reports OK for all three networks.
4. The full system is deployed and registry-wired on **both** 1874 and 2625, with addresses
   recorded in `deployments/`.
5. Spec §12 item 2 (pre-EIP-155) is answered, not open.
6. `contracts/VENDOR.md` records the upstream commit, the MIT licence, and an empty
   modifications table.

---

## Remaining plans

Each is written when its predecessor's gate is met, so that each plan is informed by what the
previous phase actually learned.

| Plan | Phase | Deliverable | Gate |
|---|---|---|---|
| 2 | Oracle hardening | `Verifier` upgraded to k-of-N with contract rails | invariant: `verify()` never accepts < k signatures, for any input |
| 3 | Price publisher + keeper | CEX ingest, index, signing, report delivery | an order completes end-to-end on 1874 |
| 4 | Indexer + API | Ponder schema, REST/WS surface | positions and candles served correctly |
| 5 | Frontend | Next.js trading UI | mouse-driven trade from deposit to close |
| 6 | Liquidator + monitoring | margin watcher, risk dashboard | liquidation fires automatically |
| 7 | Hardening | adversarial tests, audit prep | invariants hold under fuzzing |
