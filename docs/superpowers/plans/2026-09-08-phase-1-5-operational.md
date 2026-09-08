# Phase 1.5: Make the Deployed System Operational — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

## Resume point — read this first (state as of 2026-09-08, HEAD `b753f02`)

**ALL FOUR TASKS ARE COMPLETE. Phase 1.5 is done.**

| Task | State |
|---|---|
| **1. Report builder and signer** | **Done.** `8e54948` + fix `a476009`. Its encoding was independently proven against `cast` — encode, hash, EIP-191 sign and address derivation all matched byte-for-byte, so `packages/reporter/src/report.mjs` should not be changed without redoing that proof. |
| **2. Configuration script** | **Done.** `9e1c84d` → `b753f02` → `702d9d5`. Steps 6–9 landed in `702d9d5`. One deviation: Step 7's prescribed `abi.encodeWithSignature("CheatcodeError(string)", …)` does **not** match on this forge version — pinned as raw `bytes("vm.prank: cannot override…")` instead, which still discriminates against `NotGov(address)`. |
| **3. Full trade cycle on anvil** | **Done.** `1559fda`. Proved the plan's configuration was **incomplete**: see below. |
| **4. Execute against chain 1874** | **Done.** Configured live (15 txs, 1 801 375 gas, 0.009 ETH) and one BTC/USD position opened and closed. Hashes in `deployments/1874-operational.json`. |

**Task 3 found three mandatory configuration steps the plan omitted.** None reverts at
list-time, and none is visible from "did the pair reach storage?" — only a full open→close
cycle surfaces them. All three are now in `OperateScript`:

1. `setMaxOpenInterest` (manager) — `openInterest[pair][2]` defaults to 0, so every trade is
   silently cancelled `EXPOSURE_LIMITS` while the transaction *succeeds*.
2. `setPairFundingFees` (gov) — `springFactor` is a divisor; a fresh pair panics
   division-by-zero inside `performUpkeep`. Folded into `addMarket` as `_setFundingParams`.
3. `setVaultMaxAllowance` (gov, on callbacks) — without it opens succeed and **closes revert**.

`run()` therefore also needs `MANAGER_PRIVATE_KEY`. `Config` is unchanged: `tradingStorage`,
`pairInfos` and `callbacks` are resolved through the registry.

Live role assignment (no `lp.json` existed; human ruling): LP = `marketmaker`,
trader = `dev`, plus generated `signer.json` (off-chain only) and `keeper.json`. Only
`owner` had gas; the rest were topped up from it by plain transfer.

Final state: `forge test` 31/31, `node --test packages/reporter/test/` 4/4,
`evm compat gate OK: 106 bytecode objects`. Working tree clean.

The SDD ledger with the full decision trail lives at
`.superpowers/sdd/2026-09-08-phase-1-5-operational/progress.md` — it is git-ignored, so it survives a new session but not `git clean -xdx`. Everything load-bearing from it is mirrored into this plan.

**Carry into Task 4:** it must invoke `OperateScript.run()` itself and must **not** wrap the eight functions from an outside script. Calling them externally under a foreign broadcast attributes the nested vendor calls to the `OperateScript` instance rather than the broadcaster's EOA — reproduced on a live anvil, and it would break the live run.

**Goal:** Open and close one real BTC/USD position on Whitechain testnet 1874 through the genuine two-phase price flow.

**Architecture:** A Foundry script performs all on-chain configuration idempotently. A dependency-free Node module builds and signs price reports. A Forge integration test proves the entire cycle on anvil — including its four failure modes — before any gas is spent on the live network.

**Tech Stack:** Foundry (forge/cast/anvil), Solidity 0.8.24, Node 20 (`node:test`, no test-runner dependency), `viem` for ABI encoding and signing.

## Global Constraints

Every task's requirements implicitly include this section. Values copied verbatim from `docs/superpowers/specs/2026-09-08-phase-1-5-operational-design.md`.

- Solidity pinned to exactly **`0.8.24`**, `evm_version = "shanghai"`, `via_ir = true`. Never `cancun`, never `paris`.
- Emitted bytecode must contain no `TLOAD` (0x5c), `TSTORE` (0x5d), `MCOPY` (0x5e).
- **Never edit anything under `contracts/src/vendor/`.** That tree is byte-identical to upstream `8390ce497f68fb128900840e0ec30683afa945d3` and `contracts/VENDOR.md` asserts it.
- All automated transactions are **legacy type 0** (`--legacy`).
- **Prices carry exactly 18 decimals.** BTC at $65,000.00 is `65000000000000000000000`. A wrong exponent does not revert anywhere — it silently opens a position at the wrong price.
- **Collateral (USDW) carries 6 decimals.** Leverage carries 2 (`1000` = 10.00x).
- Chain 1874 RPC is `https://rpc.testnet.whitechain.io`. Chain 2625 is `https://rpc-testnet.whitechain.io` — differs by a dot vs a hyphen; not a target of this phase.
- Deployed addresses live in `deployments/1874.json`. Role keys live outside the repo at `~/.whitespace-keys/`; **never read, print, or commit a private key.**
- **Budget: 0.308 ETH remains and the faucet is CAPTCHA-gated.** Nothing runs against the live network until it is green on anvil.

## File Structure

| Path | Responsibility |
|---|---|
| `packages/reporter/package.json` | package manifest, `type: module` |
| `packages/reporter/src/report.mjs` | build report bytes, sign them, encode performData |
| `packages/reporter/test/report.test.mjs` | unit tests, including signature recovery |
| `contracts/script/Operate.s.sol` | idempotent on-chain configuration |
| `contracts/test/integration/TradeLocal.t.sol` | full open→close cycle plus four failure modes |
| `deployments/1874-operational.json` | records what configuration landed live |

---

### Task 1: Report builder and signer

**Files:**
- Create: `packages/reporter/package.json`
- Create: `packages/reporter/src/report.mjs`
- Test: `packages/reporter/test/report.test.mjs`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: three functions exported from `packages/reporter/src/report.mjs`:
  - `buildReportData({feedId, timestamp, price, bid, ask, isMarketOpen, isDayTradingClosed}) -> 0x-hex`
  - `signReport(reportData, privateKey) -> Promise<0x-hex>` (the `signedReport`)
  - `encodePerformData(signedReport, orderId) -> 0x-hex`
  Task 4 calls all three.

**Why this shape.** The module does no network access, no price sourcing and no scheduling. That keeps it a pure function of its inputs, so it is directly unit-testable, and makes it the seed of phase 3's publisher rather than throwaway scaffolding.

- [ ] **Step 1: Create the package manifest**

`packages/reporter/package.json`:

```json
{
  "name": "@whitespace/reporter",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "main": "src/report.mjs",
  "exports": { ".": "./src/report.mjs" },
  "dependencies": { "viem": "^2.21.0" }
}
```

Then install it at the repo root so `viem` resolves:

```bash
cd /home/oleksandr/Documents/whitespace && pnpm install
```

- [ ] **Step 2: Write the failing test**

The third test is the one that matters: it recovers the signer address from the produced signature, so a change to the encoding or the hashing cannot silently pass.

`packages/reporter/test/report.test.mjs`:

```javascript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decodeAbiParameters, hashMessage, keccak256, recoverAddress } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { buildReportData, signReport, encodePerformData } from '../src/report.mjs';

const KEY = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d';
const FEED = '0x4254432f55534400000000000000000000000000000000000000000000000000';
const FIELDS = {
  feedId: FEED,
  timestamp: 1757325600,
  price: 65000000000000000000000n,
  bid: 64999000000000000000000n,
  ask: 65001000000000000000000n,
  isMarketOpen: true,
  isDayTradingClosed: false,
};

test('report data round-trips through the exact on-chain tuple', () => {
  const data = buildReportData(FIELDS);
  const decoded = decodeAbiParameters(
    [
      { type: 'bytes32' }, { type: 'uint32' }, { type: 'int192' },
      { type: 'int192' }, { type: 'int192' }, { type: 'bool' }, { type: 'bool' },
    ],
    data,
  );
  assert.equal(decoded[0], FEED);
  assert.equal(decoded[1], 1757325600);
  assert.equal(decoded[2], 65000000000000000000000n);
  assert.equal(decoded[5], true);
  assert.equal(decoded[6], false);
});

test('price uses 18 decimals, so $65,000 is 65000e18', () => {
  assert.equal(FIELDS.price, 65000n * 10n ** 18n);
});

test('the signature recovers to the signing key', async () => {
  const data = buildReportData(FIELDS);
  const signed = await signReport(data, KEY);
  const [reportData, r, s, v] = decodeAbiParameters(
    [{ type: 'bytes' }, { type: 'bytes32' }, { type: 'bytes32' }, { type: 'uint8' }],
    signed,
  );
  assert.equal(reportData, data);
  const signature = `${r}${s.slice(2)}${v.toString(16).padStart(2, '0')}`;
  const recovered = await recoverAddress({ hash: hashMessage({ raw: keccak256(data) }), signature });
  assert.equal(recovered, privateKeyToAccount(KEY).address);
});

test('performData is the tuple performUpkeep decodes', () => {
  const performData = encodePerformData('0xdeadbeef', 42n);
  const [report, orderId] = decodeAbiParameters(
    [{ type: 'bytes' }, { type: 'uint256' }],
    performData,
  );
  assert.equal(report, '0xdeadbeef');
  assert.equal(orderId, 42n);
});
```

- [ ] **Step 3: Run the test to verify it fails**

```bash
cd /home/oleksandr/Documents/whitespace && node --test packages/reporter/test/
```

Expected: FAIL — `ERR_MODULE_NOT_FOUND` for `../src/report.mjs`, which does not exist yet.

- [ ] **Step 4: Write the implementation**

`packages/reporter/src/report.mjs`:

```javascript
import { encodeAbiParameters, keccak256 } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

/**
 * The tuple OstiumPrivatePriceUpKeep.performUpkeep decodes out of the verifier response.
 * Prices carry 18 decimals; a wrong exponent does not revert anywhere.
 */
const REPORT_FIELDS = [
  { type: 'bytes32' }, { type: 'uint32' }, { type: 'int192' },
  { type: 'int192' }, { type: 'int192' }, { type: 'bool' }, { type: 'bool' },
];

export function buildReportData({ feedId, timestamp, price, bid, ask, isMarketOpen, isDayTradingClosed }) {
  return encodeAbiParameters(REPORT_FIELDS, [
    feedId, timestamp, price, bid, ask, isMarketOpen, isDayTradingClosed,
  ]);
}

/**
 * OstiumVerifier.verify recovers with the EIP-191 personal_sign prefix over keccak256(reportData),
 * so we sign the raw hash as a message rather than signing it directly.
 */
export async function signReport(reportData, privateKey) {
  const account = privateKeyToAccount(privateKey);
  const signature = await account.signMessage({ message: { raw: keccak256(reportData) } });
  const r = `0x${signature.slice(2, 66)}`;
  const s = `0x${signature.slice(66, 130)}`;
  const v = parseInt(signature.slice(130, 132), 16);
  return encodeAbiParameters(
    [{ type: 'bytes' }, { type: 'bytes32' }, { type: 'bytes32' }, { type: 'uint8' }],
    [reportData, r, s, v],
  );
}

export function encodePerformData(signedReport, orderId) {
  return encodeAbiParameters([{ type: 'bytes' }, { type: 'uint256' }], [signedReport, orderId]);
}
```

- [ ] **Step 5: Run the test to verify it passes**

```bash
cd /home/oleksandr/Documents/whitespace && node --test packages/reporter/test/
```

Expected: PASS, 4 tests.

- [ ] **Step 6: Commit**

```bash
git add packages/reporter package.json pnpm-lock.yaml
git commit -m "feat: add price report builder and signer"
```

---

### Task 2: Idempotent on-chain configuration script

**Files:**
- Create: `contracts/script/Operate.s.sol`
- Test: `contracts/test/integration/Operate.t.sol`

**Interfaces:**
- Consumes: the deployed addresses in `deployments/1874.json`; `USDW` from `contracts/src/mocks/USDW.sol`.
- Produces: `struct Config { address registry; address usdw; address pairsStorage; address vault; address verifier; address priceUpKeep; address signer; address keeper; address lp; uint256 lpAmount; }`
  and **eight sender-scoped public functions**, each of which must be called by exactly one role:

  | Function | Required `msg.sender` | Returns |
  |---|---|---|
  | `addMarket(Config memory c)` | gov | `uint16 pairIndex` |
  | `authoriseSigner(Config memory c)` | gov | — |
  | `authoriseForwarder(Config memory c)` | registry `owner()` | — |
  | `registerUpkeep(Config memory c)` | gov | — |
  | `mintToLp(Config memory c)` | USDW `owner()` | — |
  | `requestLpDeposit(Config memory c)` | `c.lp` | `uint32 settlementId` |
  | `settle(Config memory c)` | gov | — |
  | `claimLpDeposit(Config memory c, uint32 settlementId)` | `c.lp` | — |

  Task 3 and Task 4 both drive these. Task 3 wraps each in `vm.prank`; Task 4's `run()` wraps each in its own `vm.startBroadcast(key)`.

**Why eight functions and not one.** The steps need three different senders — gov for the registry and market calls, the registry `owner()` for `registerForwarder` (which is `onlyTimelock`, and `onlyTimelock` resolves to `IOwnable(registry).owner()` in this codebase), and the LP for the ERC-4626 deposit dance. A single function cannot satisfy all three: in a test the caller would be the script contract and the first `addGroup` would revert `NotGov`, and in a live script one `vm.startBroadcast` cannot switch sender mid-call. Splitting by sender also gives each unit one responsibility and makes each independently prankable in tests.

**Why idempotent.** The live deployment cannot be repeated for want of gas, so a run that fails halfway must be safe to resume. Every function begins with a read that answers "already done?" and returns early if so.

**Values chosen, and the check each satisfies.** These were derived by reading the vendored modifiers; do not substitute others without re-reading them.

| Struct | Field | Value | Satisfies |
|---|---|---|---|
| `Group` | `name` | `bytes32("Crypto")` | unchecked |
| | `minLeverage` | `100` (1.00x) | `>= MIN_LEVERAGE = 100` |
| | `maxLeverage` | `50000` (500.00x) | `<= MAX_LEVERAGE = 100000`, `> minLeverage` |
| | `maxCollateralP` | `2000` (20.00% of vault balance) | unchecked |
| `Fee` | `name` | `bytes32("BTC-USD")` | **must be non-zero** — `feeOk` does not check it, but `_feeListed` rejects `bytes32(0)` forever |
| | `minLevPos` | `10_000_000` ($10, 6 dp) | `!= 0` |
| | `oracleFee` | `1_000_000` ($1, 6 dp) | `!= 0`, `<= MAX_ORACLE_FEE = 10e6` |
| | `liqFeeP` | `50` | `<= 100` — a plain integer, *not* PRECISION_2 |
| `Pair` | `from` / `to` | `bytes32("BTC")` / `bytes32("USD")` | free-form; the `isPairListed` key |
| | `feed` | `bytes32("BTC/USD")` | ours to choose — we sign our own reports; must equal the report's `feedId` |
| | `tradeSizeRef` | `0` | never read in this vendored snapshot |
| | `overnightMaxLeverage` | `0` | trivially satisfies both overnight checks |
| | `maxLeverage` | `10000` (100.00x) | `<= MAX_LEVERAGE`, `>= group.minLeverage` |
| | `groupIndex` / `feeIndex` | `0` / `0` | index 0 is valid once the first group and fee are added |
| | `oracle` | `"BTC/USD"` | determines the registry key `"BTC/USDPriceUpkeep"` |

- [ ] **Step 1: Write the failing test**

`contracts/test/integration/Operate.t.sol`:

```solidity
// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {DeployScript} from "../../script/Deploy.s.sol";
import {OperateScript} from "../../script/Operate.s.sol";
import {IOstiumRegistry} from "../../src/vendor/ostium/interfaces/IOstiumRegistry.sol";
import {IOstiumPairsStorage} from "../../src/vendor/ostium/interfaces/IOstiumPairsStorage.sol";
import {IOstiumVerifier} from "../../src/vendor/ostium/interfaces/IOstiumVerifier.sol";

contract OperateTest is Test {
    DeployScript internal deployer;
    OperateScript internal operator;
    DeployScript.Deployment internal d;

    address internal gov = address(0x60F);
    address internal dev = address(0xDE7);
    address internal manager = address(0xA11);
    address internal marketMaker = address(0x33D);
    address internal signer = address(0x51D);
    address internal keeper = address(0x1EE);
    address internal lp = address(0x1B0);

    function setUp() public {
        deployer = new DeployScript();
        d = deployer.deployAll(
            DeployScript.Roles({
                gov: gov, dev: dev, manager: manager, owner: address(this), marketMaker: marketMaker
            })
        );
        operator = new OperateScript();
    }

    function _config() internal view returns (OperateScript.Config memory) {
        return OperateScript.Config({
            registry: d.registry, usdw: d.collateral, pairsStorage: d.pairsStorage,
            vault: d.vault, verifier: d.verifier, priceUpKeep: d.priceUpKeep,
            signer: signer, keeper: keeper, lp: lp, lpAmount: 100_000e6
        });
    }

    /// @dev Drives every step with the sender each one requires. Reused by every test here and
    ///      mirrored by `run()`, which swaps each prank for its own broadcast.
    function _configureAll() internal returns (uint16 pairIndex) {
        OperateScript.Config memory c = _config();
        vm.prank(gov);          pairIndex = operator.addMarket(c);
        vm.prank(gov);          operator.authoriseSigner(c);
        vm.prank(address(this)); operator.authoriseForwarder(c);   // registry owner
        vm.prank(gov);          operator.registerUpkeep(c);
        vm.prank(address(this)); operator.mintToLp(c);             // USDW owner
        vm.prank(lp);           uint32 settlementId = operator.requestLpDeposit(c);
        vm.prank(gov);          operator.settle(c);
        vm.prank(lp);           operator.claimLpDeposit(c, settlementId);
    }

    function test_listsPairAtIndexZero() public {
        assertEq(_configureAll(), 0);
        assertEq(IOstiumPairsStorage(d.pairsStorage).pairFeed(0), bytes32("BTC/USD"));
    }

    function test_authorisesSigner() public {
        _configureAll();
        assertTrue(IOstiumVerifier(d.verifier).isAuthorizedSigner(signer));
    }

    /// @dev The registry key is derived from Pair.oracle, not from the struct field name.
    function test_priceUpKeepRegisteredUnderOracleDerivedKey() public {
        _configureAll();
        assertEq(
            IOstiumRegistry(d.registry).getContractAddress(bytes32("BTC/USDPriceUpkeep")),
            d.priceUpKeep
        );
    }

    /// @dev Zero vault balance silently cancels every trade in the callback, so this is the
    ///      single most important post-condition of configuration.
    function test_vaultHasLiquidity() public {
        _configureAll();
        (bool ok, bytes memory ret) = d.vault.staticcall(abi.encodeWithSignature("currentBalance()"));
        assertTrue(ok);
        assertGt(abi.decode(ret, (uint256)), 0);
    }

    /// @dev Each function must no-op on a second call, because a live run that dies halfway
    ///      has to be resumable and there is not enough gas for a fresh deployment.
    function test_everyStepIsIdempotent() public {
        uint16 first = _configureAll();
        uint16 second = _configureAll();
        assertEq(first, second);
        assertEq(IOstiumPairsStorage(d.pairsStorage).pairsCount(), 1);
    }

    /// @dev Wrong sender must fail loudly rather than half-configure.
    function test_addMarketRejectsNonGov() public {
        vm.prank(address(0xBAD));
        vm.expectRevert();
        operator.addMarket(_config());
    }
}
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd contracts && forge test --match-path test/integration/Operate.t.sol -vv
```

Expected: FAIL — `Source "script/Operate.s.sol" not found`.

- [ ] **Step 3: Write the configuration script**

Read `contracts/script/Deploy.s.sol` first and follow its conventions: it uses `abi.encodeCall` throughout so every signature is compiler-checked, and it prefixes broadcast-only work inside `run()`.

`contracts/script/Operate.s.sol` must:

1. Declare `struct Config` exactly as given in **Interfaces** above.

2. Implement the eight sender-scoped functions. Each begins with its own "already done?" read and returns early:

   - `addMarket` — `addGroup(Group{name: bytes32("Crypto"), minLeverage: 100, maxLeverage: 50000, maxCollateralP: 2000})`, skipped if `groupsCount() > 0`; then `addFee(Fee{name: bytes32("BTC-USD"), minLevPos: 10_000_000, oracleFee: 1_000_000, liqFeeP: 50})`, skipped if `feesCount() > 0`; then `addPair(Pair{...})` with the table's values, skipped if `isPairListed(bytes32("BTC"), bytes32("USD"))`. Returns the pair index — `pairsCount() - 1` after the call, or the existing index when skipping.
   - `authoriseSigner` — `IOstiumVerifier(c.verifier).registerAuthorizedSigner(c.signer)`, skipped if `isAuthorizedSigner(c.signer)`.
   - `authoriseForwarder` — `registerForwarder(c.keeper)` on `c.priceUpKeep`, skipped if `isForwarder(c.keeper)`.
   - `registerUpkeep` — `IOstiumRegistry(c.registry).registerContract(bytes32("BTC/USDPriceUpkeep"), c.priceUpKeep)`. Guard with `try/catch`, because `getContractAddress` **reverts `NotFound`** rather than returning zero: attempt the read, and register only when it reverts.
   - `mintToLp` — `USDW(c.usdw).mint(c.lp, c.lpAmount)`, skipped if `balanceOf(c.lp) >= c.lpAmount`.
   - `requestLpDeposit` — read `settlementId = IOstiumVault(c.vault).targetSettlementId(true)` **before** requesting, then `IERC20(c.usdw).approve(c.vault, c.lpAmount)` and `requestDeposit(c.lpAmount)`. Note the approve target is the **vault itself**, because the vault executes `safeTransferFrom` from inside its own code. Returns the settlement id. Skipped, returning `0`, if `currentBalance() > 0`.
   - `settle` — `IOstiumVault(c.vault).forceSettlement()`, skipped if `currentBalance() > 0`. This advances `lastSettlementId`, refreshes `shareToAssetsPrice`, and mints the pooled shares into the vault's own escrow.
   - `claimLpDeposit` — `IOstiumVault(c.vault).claimDeposit(settlementId)`, skipped if `settlementId == 0` or `currentBalance() > 0`.

3. `run()` — guarded by `require(block.chainid == 1874, "unsupported chain")`, reading addresses from `deployments/1874.json` with `vm.readFile` and role keys from the environment. Call the eight functions in the order listed, each wrapped in its **own** `vm.startBroadcast(<role key>)` / `vm.stopBroadcast()` pair, because each needs a different sender.

Use `vm.prank` only in the test; in `run()` use per-role broadcasts. Follow `contracts/script/Deploy.s.sol`'s conventions — in particular it uses `abi.encodeCall` so every signature is compiler-checked, which is what caught zero signature errors during phase 1.

- [ ] **Step 4: Run the test to verify it passes**

```bash
cd contracts && forge test --match-path test/integration/Operate.t.sol -vv
```

Expected: PASS, 5 tests.

- [ ] **Step 5: Commit**

```bash
git add contracts/script/Operate.s.sol contracts/test/integration/Operate.t.sol
git commit -m "feat: add idempotent market configuration script"
```

---

## Task 2 — remaining work found by re-review (start a new session here)

Steps 1–5 are **done and committed**: `9e1c84d`, then fix round 1 as `9d4e7bb` + `b753f02`. The suite is at 25/25 and the Cancun gate reports 104 objects. A scoped re-review confirmed all seven earlier findings addressed, and found the two items below. Both have verified fixes; neither is speculative.

- [ ] **Step 6: Close the fresh-process resume gap in `claimLpDeposit`**

**The defect, reproduced by the re-reviewer.** If a live run dies strictly between `settle()` and `claimLpDeposit()` and is resumed by a **fresh process**, the claim never happens and never self-heals:

- `settle()` advances `lastSettlementId` 1 → 2 (`OstiumVault.sol:793`).
- The resumed `requestLpDeposit` reads `targetSettlementId(true) = lastSettlementId + 1 = 3`, sees `getDepositStatus(lp, 3) == NONE`, falls through to `currentBalance() > 0`, and correctly returns `0`.
- `run()` then calls `claimLpDeposit(c, 0)`, which reads `getDepositStatus(lp, 0) == NONE ≠ CLAIMABLE` and skips.

Measured end state after a full resume pass: `balanceOf(lp) == 0`, `1e11` escrowed at the vault, `pendingDepositRequest[lp][2] == 1e11`, `getDepositStatus(lp, 2) == CLAIMABLE`. Three further passes do not fix it, and every one reports success.

This matters because in `run()` that window spans two *separate* broadcasts, so a dropped or underpriced final transaction is exactly its shape. Funds are not lost — the status has no expiry, so `cast send $VAULT "claimDeposit(uint32)" 2` recovers it — but nothing surfaces the problem. It is the last surviving instance of the "a step silently does nothing" shape that C1 was.

Fix — derive the id inside `claimLpDeposit` when passed `0`:

```solidity
uint32 id = settlementId == 0 ? vault.targetSettlementId(true) - 1 : settlementId; // == lastSettlementId
if (vault.getDepositStatus(c.lp, id) != IOstiumVault.RequestStatus.CLAIMABLE) return;
_relay(msg.sender);
vault.claimDeposit(id);
```

No underflow: `targetSettlementId(true) = lastSettlementId + 1 ≥ 1`. The re-reviewer ran exactly this against the stuck state — derived id 2, status `CLAIMABLE`, shares transferred, `balanceOf(lp) > 0` — and confirmed it leaves the clean two-pass case untouched, so `Operate.t.sol`'s `assertEq(secondSettlementId, 0)` stays valid.

Known limit, acceptable here: it inspects only `lastSettlementId`, so it would miss a deposit stranded behind a *later* settlement. On 1874 every settlement is operator-driven and `maxSettlementInterval` is 86400 s, so that cannot happen between two runs of this script.

- [ ] **Step 7: Make the relay regression test discriminate**

`contracts/test/integration/Operate.t.sol`, `test_relayFailsLoudlyOnConflictingOuterPrank` uses a bare `vm.expectRevert()` — the same flaw finding I4 was raised about, reintroduced in the round that fixed it. The re-reviewer proved it non-discriminating: it **passes** against a copy of the script with the old `try vm.prank(who) {} catch {}` restored, because the misattributed call reverts too, just with `NotGov(<script address>)` instead. The test guards nothing.

The two payloads are trivially separable — `0xeeaa9e6f` `CheatcodeError(string)` versus `0x093650d5` `NotGov(address)`. Pin it:

```solidity
vm.expectRevert(
    abi.encodeWithSignature(
        "CheatcodeError(string)",
        "vm.prank: cannot override an ongoing prank with a single vm.prank; use vm.startPrank to override the current prank"
    )
);
```

- [ ] **Step 8: Prove both fixes discriminate**

- For Step 6: add a `_passDyingAfterSettle()` helper that runs every step through `settle` and stops, then a test that constructs a fresh `new OperateScript()`, runs a full pass, and asserts `IERC20(d.vault).balanceOf(lp) > 0`. It must **fail on `b753f02`** and pass with the derivation. Capture both outputs verbatim.
- For Step 7: run the pinned test against a scratch copy of the script with the old `try/catch` relay restored, and show it now **fails**. Restore and show it passes. Keep the scratch copy under `/tmp`; never commit it.

- [ ] **Step 9: Commit**

```bash
git add contracts/script/Operate.s.sol contracts/test/integration/Operate.t.sol
git commit -m "fix(operate): claim deposits on fresh-process resume"
```

### Deferred notes for Task 2, recorded rather than fixed

- `_broadcasting` is set `true` in `run()` and never reset. Harmless today because `run()` is terminal and no test calls it, but if Task 4 ever drives individual functions under `vm.prank` on the same instance, every `_relay` would silently no-op. A symmetric reset removes the footgun.
- `.superpowers/…/task-2-report.md:150-153` still lists the pre-fix predicates as current; the fix section supersedes it but the stale list reads as authoritative.
- `_findPairIndex`'s defensive revert is unreachable and untested.
- `mintToLp`'s first gate treats "the vault has liquidity from anyone" as done, so a pre-seeded vault would mean our LP contributes nothing. Cannot bite on 1874, where the vault deploys empty.

---

### Task 3: Full trade cycle on anvil, with its failure modes

**Files:**
- Test: `contracts/test/integration/TradeLocal.t.sol`

**Interfaces:**
- Consumes: `DeployScript.deployAll` (already committed) and Task 2's eight sender-scoped functions on `OperateScript`. Copy Task 2's `_configureAll()` helper — the one that wraps each call in the `vm.prank` its role requires — rather than inventing a second driver.
- Produces: nothing later tasks import; this is the gate that authorises spending gas in Task 4.

**Why the failure modes are mandatory.** Three of them revert with distinct errors we must be able to recognise from a live transaction rather than guess at. The fourth does **not** revert at all: with an empty vault, `withinExposureLimits` compares collateral against `groupMaxCollateral = maxCollateralP * vault.currentBalance() / 10000`, which is zero, so the callback cancels the trade with `CancelReason.EXPOSURE_LIMITS` and refunds the collateral minus the oracle fee. A test that only asserts "the transaction succeeded" would pass while no position exists.

- [ ] **Step 1: Write the failing test**

`contracts/test/integration/TradeLocal.t.sol` must contain these test functions. Build the signed report inside Solidity with `vm.sign` over `keccak256(abi.encodePacked("\x19Ethereum Signed Message:\n32", keccak256(reportData)))`, mirroring `OstiumVerifier.verify`.

```solidity
// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {DeployScript} from "../../script/Deploy.s.sol";
import {OperateScript} from "../../script/Operate.s.sol";
import {IOstiumTradingStorage} from "../../src/vendor/ostium/interfaces/IOstiumTradingStorage.sol";

contract TradeLocalTest is Test {
    uint256 internal constant SIGNER_KEY = 0xA11CE;
    int192 internal constant BTC_65K = 65000000000000000000000; // 18 decimals

    /// @dev Mirrors OstiumVerifier.verify exactly: it recovers over the EIP-191 prefix applied
    ///      to keccak256(reportData). Getting this wrong makes every delivery revert
    ///      NotAuthorizedSigner with a garbage recovered address, which is a confusing symptom.
    function _buildReport(bytes32 feedId, uint32 timestamp, int192 price, uint256 signingKey)
        internal
        pure
        returns (bytes memory signedReport)
    {
        bytes memory reportData =
            abi.encode(feedId, timestamp, price, price - 1e18, price + 1e18, true, false);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(
            signingKey,
            keccak256(abi.encodePacked("\x19Ethereum Signed Message:\n32", keccak256(reportData)))
        );
        signedReport = abi.encode(reportData, r, s, v);
    }

    function test_openAndClosePosition() public { }
    function test_unregisteredSignerReverts() public { }        // NotAuthorizedSigner
    function test_wrongTimestampReverts() public { }            // InvalidPrice
    function test_nonForwarderReverts() public { }              // NotForwarder
    function test_emptyVaultCancelsSilently() public { }        // no revert, no position
}
```

`vm.sign` is a cheatcode on `Vm`, so `_buildReport` cannot literally be `pure` — declare it
`internal view` if the compiler objects; the signature is otherwise exactly as above.

Fill each remaining body as follows.

`test_openAndClosePosition`: configure with `vm.addr(SIGNER_KEY)` as the signer; mint USDW to a trader; **approve `d.tradingStorage`, not `d.trading`**; call `openTrade` with `Trade{collateral: 1000e6, openPrice: uint192(BTC_65K), tp: 0, sl: 0, trader: trader, leverage: 1000, pairIndex: 0, index: 0, buy: true, isDayTrade: false}`, an empty `BuilderFee{builder: address(0), builderFee: 0}`, `OpenOrderType.MARKET`, and `slippageP = 100`; capture `orderId` from the `PriceRequestedV2` log via `vm.recordLogs`; deliver `performUpkeep(abi.encode(signedReport, orderId))` pranked as the keeper; assert a position now exists in `tradingStorage`; then `closeTradeMarket(0, 0, 0, uint192(BTC_65K), 100)`, deliver a second report for the new order id, and assert the trader's USDW balance changed.

`test_unregisteredSignerReverts`: sign with a key that was never registered; expect `performUpkeep` to revert `NotAuthorizedSigner`.

`test_wrongTimestampReverts`: sign a report whose `timestamp` is `order.timestamp + 1`; expect revert `InvalidPrice`.

`test_nonForwarderReverts`: deliver a valid report from an address that is not the keeper; expect revert `NotForwarder`.

`test_emptyVaultCancelsSilently`: drive only the market and authorisation steps — `addMarket`, `authoriseSigner`, `authoriseForwarder`, `registerUpkeep` — and **skip the four vault-seeding steps entirely**, so `currentBalance()` stays zero. Open a trade and deliver a valid report, then assert **no revert occurred and no position exists**: read the trade out of `tradingStorage` and assert its `collateral` is zero. This is the one failure mode that produces a successful transaction, so a test asserting only "the call succeeded" would pass while nothing was opened.

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd contracts && forge test --match-path test/integration/TradeLocal.t.sol -vv
```

Expected: FAIL — the empty function bodies assert nothing, so `test_openAndClosePosition` fails once its assertions are written, and compilation fails first if `_buildReport` has no return.

- [ ] **Step 3: Fill in the bodies and iterate until green**

Work one test at a time. If `test_openAndClosePosition` shows a successful transaction but no position, read the emitted `MarketOpenCanceled`-style event for the `CancelReason` — that enum names exactly which precondition failed, and is far faster than bisecting.

- [ ] **Step 4: Run the whole suite**

```bash
cd contracts && forge test
```

Expected: all previously passing tests still pass, plus 5 new ones.

- [ ] **Step 5: Run the Cancun gate over the new build**

```bash
cd /home/oleksandr/Documents/whitespace && node tools/evm-compat/scan.mjs contracts/out
```

Expected: `evm compat gate OK: <n> bytecode objects, no Cancun opcodes`.

- [ ] **Step 6: Commit**

```bash
git add contracts/test/integration/TradeLocal.t.sol
git commit -m "test: prove the full trade cycle and its failure modes"
```

---

### Task 4: Execute against chain 1874

**Files:**
- Create: `deployments/1874-operational.json`
- Modify: `docs/runbooks/deploy-testnet.md`

**Interfaces:**
- Consumes: everything above.
- Produces: a live, tradeable market. No code later tasks import.

**This task spends real gas and is not repeatable.** Do not begin it until Tasks 1–3 are green. Stop and report rather than improvising if any step behaves differently from the anvil run.

- [ ] **Step 1: Re-check the preconditions**

```bash
cd /home/oleksandr/Documents/whitespace
node tools/chain-probe/probe.mjs
cast balance 0xDa13C59838D9edDBD313b9B32FC47F5F2D65D113 --rpc-url https://rpc.testnet.whitechain.io
```

Expected: probe reports OK for all three networks; balance is non-zero. Record both.

- [ ] **Step 2: Simulate the configuration**

```bash
cd contracts && forge script script/Operate.s.sol:OperateScript \
  --rpc-url https://rpc.testnet.whitechain.io --legacy
```

Expected: `SIMULATION COMPLETE`. Record the estimated gas and cost. **Stop here and report the estimate — a human must approve the spend before broadcasting.**

- [ ] **Step 3: Broadcast the configuration**

```bash
cd contracts && forge script script/Operate.s.sol:OperateScript \
  --rpc-url https://rpc.testnet.whitechain.io --broadcast --legacy -vvv
```

Expected: `ONCHAIN EXECUTION COMPLETE & SUCCESSFUL`.

- [ ] **Step 4: Verify the configuration landed**

```bash
RPC=https://rpc.testnet.whitechain.io
REG=0xD6Cc323BF2736B121586B2929E0E27a80DDCC98A
PS=0xc5B68AfA8f64288f6d06DEfC5c07555Ef5323397
V=0x7B9147B4b8b05e7e3c3F86694d8EA7a639c2D516
cast call $PS "pairsCount()(uint16)" --rpc-url $RPC
cast call $PS "pairFeed(uint16)(bytes32)" 0 --rpc-url $RPC
cast call $REG "getContractAddress(bytes32)(address)" \
  $(cast format-bytes32-string "BTC/USDPriceUpkeep") --rpc-url $RPC
cast call $V "currentBalance()(uint256)" --rpc-url $RPC
```

Expected: `pairsCount` is 1; `pairFeed(0)` decodes to `BTC/USD`; the registry returns the priceUpKeep address; **`currentBalance()` is greater than zero** — if it is zero, every trade will be silently cancelled, so stop and diagnose before trading.

- [ ] **Step 5: Open one position**

Use the reporter module from Task 1 to sign the report for the exact timestamp emitted in `PriceRequestedV2`. Record the order id, the report, the transaction hashes, and the resulting position.

- [ ] **Step 6: Close it**

Close the position through the same two-phase flow and record the trader's USDW balance before and after.

- [ ] **Step 7: Record and document**

Write `deployments/1874-operational.json` capturing the pair index, the feed id, the signer address, the keeper address, the LP amount, and the two trade transaction hashes. Update `docs/runbooks/deploy-testnet.md`: its status block still says the deployment has not been performed, which is no longer true, and it needs a section describing how to configure a market and push a report.

- [ ] **Step 8: Commit**

```bash
git add deployments/1874-operational.json docs/runbooks/deploy-testnet.md
git commit -m "feat: configure and trade BTC/USD on Whitechain 1874"
```

---

## Phase gate

Phase 1.5 is complete when all of these hold:

1. `forge test` passes, including the five new tests in `TradeLocal.t.sol`.
2. `node --test packages/reporter/test/` passes.
3. `node tools/evm-compat/scan.mjs contracts/out` reports no Cancun opcodes.
4. Chain 1874 has one listed pair, an authorised signer, an allowlisted forwarder, a registered `BTC/USDPriceUpkeep`, and a vault with non-zero `currentBalance()`.
5. One position has been opened **and** closed on 1874, with the transaction hashes recorded in `deployments/1874-operational.json`.
6. `docs/runbooks/deploy-testnet.md` no longer claims the system is undeployed.

## What this phase deliberately leaves undone

| Left undone | Owner |
|---|---|
| Multi-venue ingest, index construction, EMA mark price | phase 3 |
| k-of-N threshold signatures and contract rails — `verify` is 1-of-N by construction and `external view`, so both need vendored-source changes | phase 2 |
| Liquidations | phase 6 |
| Any UI | phase 5 |
| Chain 2625 — still unfunded, no gas source found | blocked |
