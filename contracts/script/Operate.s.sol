// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Script} from "forge-std/Script.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {USDW} from "../src/mocks/USDW.sol";
import {IOstiumRegistry} from "../src/vendor/ostium/interfaces/IOstiumRegistry.sol";
import {IOstiumPairsStorage} from "../src/vendor/ostium/interfaces/IOstiumPairsStorage.sol";
import {IOstiumVerifier} from "../src/vendor/ostium/interfaces/IOstiumVerifier.sol";
import {IOstiumVault} from "../src/vendor/ostium/interfaces/IOstiumVault.sol";
import {IOstiumForwarded} from "../src/vendor/ostium/interfaces/IOstiumForwarded.sol";
import {OstiumVault} from "../src/vendor/ostium/OstiumVault.sol";

/// @notice Idempotent, sender-scoped configuration of an already-deployed Ostium system:
///         lists the BTC/USD market, authorises the price-report signer and the keeper
///         forwarder, registers the price upkeep, and seeds the vault with LP liquidity.
/// @dev    Eight public functions, each assuming exactly one `msg.sender` role (gov, the
///         registry's `owner()` a.k.a. timelock, the USDW `owner()`, or the LP), because the
///         steps genuinely need three different senders and neither a single `vm.prank` nor a
///         single `vm.startBroadcast` can switch sender mid-call. `run()` drives all eight with
///         its own `vm.startBroadcast(key)` per function; `test/integration/Operate.t.sol`
///         drives them with `vm.prank(role)` per function.
///
///         Every function begins with a read that answers "already done?" and returns early,
///         because the live deployment cannot be repeated for want of gas: a run that dies
///         halfway must be safe to resume.
contract OperateScript is Script {
    struct Config {
        address registry;
        address usdw;
        address pairsStorage;
        address vault;
        address verifier;
        address priceUpKeep;
        address signer;
        address keeper;
        address lp;
        uint256 lpAmount;
    }

    // Values chosen to satisfy the vendored modifiers with headroom; see OstiumPairsStorage.sol
    // for MIN_LEVERAGE/MAX_LEVERAGE/MAX_ORACLE_FEE and the addGroup/addFee/addPair checks.
    bytes32 internal constant GROUP_NAME = "Crypto";
    uint16 internal constant GROUP_MIN_LEVERAGE = 100; // 1.00x, == MIN_LEVERAGE
    uint32 internal constant GROUP_MAX_LEVERAGE = 50_000; // 500.00x, <= MAX_LEVERAGE = 100000
    uint16 internal constant GROUP_MAX_COLLATERAL_P = 2000; // 20.00% of vault currentBalance()

    bytes32 internal constant FEE_NAME = "BTC-USD"; // must be non-zero: gates _feeListed forever
    uint64 internal constant FEE_MIN_LEV_POS = 10_000_000; // $10, PRECISION_6
    uint64 internal constant FEE_ORACLE_FEE = 1_000_000; // $1, PRECISION_6, <= MAX_ORACLE_FEE
    uint16 internal constant FEE_LIQ_FEE_P = 50; // <= 100, plain integer not PRECISION_2

    bytes32 internal constant PAIR_FROM = "BTC";
    bytes32 internal constant PAIR_TO = "USD";
    bytes32 internal constant PAIR_FEED = "BTC/USD"; // must equal our own price report's feedId
    string internal constant PAIR_ORACLE = "BTC/USD"; // determines the registry key below
    uint32 internal constant PAIR_MAX_LEVERAGE = 10_000; // 100.00x

    // OstiumPriceRouter.sol:81-84 and OstiumTradingCallbacks.sol:83-85 both resolve the
    // per-oracle upkeep registry key as bytes32(abi.encodePacked(pair.oracle, "PriceUpkeep")).
    // With PAIR_ORACLE == "BTC/USD" that is fixed at deploy time, so it is safe to inline here.
    bytes32 internal constant PRICE_UPKEEP_KEY = "BTC/USDPriceUpkeep";

    /// @dev Set by `run()`, once, before any of the eight functions execute. Distinguishes
    ///      "driven by `vm.startBroadcast`" from "driven by `vm.prank`" so `_relay` knows
    ///      whether it needs to do anything at all.
    bool private _broadcasting;

    /// @dev Foundry's `vm.prank` overrides `msg.sender` for exactly the next call, no deeper —
    ///      confirmed empirically against forge 0.3.0: a prank set by the test is consumed by
    ///      the call INTO one of this contract's public functions, so by the time that function
    ///      makes its OWN nested call into pairsStorage/verifier/vault/etc., the nested call
    ///      would otherwise see `address(this)` (this script), not the intended role. Each
    ///      mutating nested call is therefore preceded by `_relay(msg.sender)` to re-establish
    ///      the correct sender for that one hop.
    ///
    ///      Under `run()`, these same functions are invoked as plain internal calls wrapped in
    ///      `vm.startBroadcast(key)`, which — unlike `vm.prank` — persists across every
    ///      subsequent call this contract makes until `vm.stopBroadcast()`, so no relay is
    ///      needed there; broadcast already attributes every nested call correctly (this is the
    ///      same mechanism `Deploy.s.sol`'s `deployAll()` relies on). `vm.prank` also cannot be
    ///      called at all while a broadcast is active — it reverts unconditionally with
    ///      "cannot `prank` for a broadcasted transaction", confirmed empirically.
    ///
    ///      An earlier version swallowed that revert with a bare `try/catch` so one `_relay`
    ///      worked under both callers. That is unsound: under a *test's own* `vm.startPrank`
    ///      (not `run()`'s broadcast), the inner `vm.prank` here can ALSO fail — for an
    ///      unrelated reason ("cannot override an ongoing prank with a single vm.prank") — and
    ///      the bare catch would swallow that too, silently misattributing the nested call to
    ///      this script contract instead of loudly failing. Reproduced empirically. `run()`
    ///      therefore sets `_broadcasting = true` explicitly, and `_relay` branches on it
    ///      instead of on whether `vm.prank` happens to succeed: no `vm.prank` call is even
    ///      attempted while broadcasting, and outside of broadcasting an unexpected prank
    ///      failure now propagates instead of being hidden.
    function _relay(address who) internal {
        if (_broadcasting) return;
        vm.prank(who);
    }

    /// @notice Lists the BTC/USD market: the Crypto group, the BTC-USD fee tier, and the pair
    ///         itself, each skipped independently if already present.
    /// @dev Caller must be `registry.gov()` (checked by `pairsStorage`'s `onlyGov` modifiers).
    function addMarket(Config memory c) public returns (uint16 pairIndex) {
        IOstiumPairsStorage ps = IOstiumPairsStorage(c.pairsStorage);

        if (ps.groupsCount() == 0) {
            _relay(msg.sender);
            ps.addGroup(
                IOstiumPairsStorage.Group({
                    name: GROUP_NAME,
                    minLeverage: GROUP_MIN_LEVERAGE,
                    maxLeverage: GROUP_MAX_LEVERAGE,
                    maxCollateralP: GROUP_MAX_COLLATERAL_P
                })
            );
        }

        if (ps.feesCount() == 0) {
            _relay(msg.sender);
            ps.addFee(
                IOstiumPairsStorage.Fee({
                    name: FEE_NAME,
                    minLevPos: FEE_MIN_LEV_POS,
                    oracleFee: FEE_ORACLE_FEE,
                    liqFeeP: FEE_LIQ_FEE_P
                })
            );
        }

        if (ps.isPairListed(PAIR_FROM, PAIR_TO)) {
            return _findPairIndex(ps);
        }

        _relay(msg.sender);
        ps.addPair(
            IOstiumPairsStorage.Pair({
                from: PAIR_FROM,
                to: PAIR_TO,
                feed: PAIR_FEED,
                tradeSizeRef: 0,
                overnightMaxLeverage: 0,
                maxLeverage: PAIR_MAX_LEVERAGE,
                groupIndex: 0,
                feeIndex: 0,
                oracle: PAIR_ORACLE
            })
        );

        return ps.pairsCount() - 1;
    }

    /// @dev `isPairListed` has no reverse (from,to) -> index lookup, so on the idempotent
    ///      skip path we scan the (small, script-managed) pair list for the match.
    function _findPairIndex(IOstiumPairsStorage ps) internal view returns (uint16) {
        uint16 count = ps.pairsCount();
        for (uint16 i = 0; i < count; i++) {
            (bytes32 from, bytes32 to,,,,,,,) = ps.pairs(i);
            if (from == PAIR_FROM && to == PAIR_TO) {
                return i;
            }
        }
        revert("BTC/USD pair not found despite isPairListed() == true");
    }

    /// @notice Authorises `c.signer` to sign price reports the verifier will accept.
    /// @dev Caller must be `registry.gov()` (checked by `OstiumVerifier`'s `onlyGov`).
    function authoriseSigner(Config memory c) public {
        IOstiumVerifier verifier = IOstiumVerifier(c.verifier);
        if (verifier.isAuthorizedSigner(c.signer)) return;
        _relay(msg.sender);
        verifier.registerAuthorizedSigner(c.signer);
    }

    /// @notice Allowlists `c.keeper` as a forwarder on the price upkeep.
    /// @dev Caller must be `IOwnable(c.registry).owner()` — `registerForwarder` is
    ///      `onlyTimelock`, which resolves to the registry's `owner()` in this codebase.
    function authoriseForwarder(Config memory c) public {
        IOstiumForwarded upkeep = IOstiumForwarded(c.priceUpKeep);
        if (upkeep.isForwarder(c.keeper)) return;
        _relay(msg.sender);
        upkeep.registerForwarder(c.keeper);
    }

    /// @notice Registers `c.priceUpKeep` under the oracle-derived registry key.
    /// @dev Caller must be `registry.gov()` (checked by `OstiumRegistry`'s `onlyGov`).
    ///      `getContractAddress` reverts `NotFound` rather than returning zero for an unknown
    ///      name, so the "already done?" check is a try/catch on the read, not a zero compare.
    function registerUpkeep(Config memory c) public {
        IOstiumRegistry registry = IOstiumRegistry(c.registry);
        try registry.getContractAddress(PRICE_UPKEEP_KEY) returns (address) {
            return;
        } catch {
            _relay(msg.sender);
            registry.registerContract(PRICE_UPKEEP_KEY, c.priceUpKeep);
        }
    }

    /// @notice Mints `c.lpAmount` of USDW to the LP so it can fund the vault.
    /// @dev Caller must be `USDW(c.usdw).owner()` (checked by `USDW`'s `onlyOwner`).
    ///
    ///      Two independent "already done?" signals, checked in this order:
    ///
    ///      1. `currentBalance() > 0` — the configuration's actual goal (a non-empty vault) is
    ///         already satisfied by an earlier, fully-completed cycle. Needed in addition to
    ///         (2): once a deposit has been claimed, the LP holds vault SHARES, not USDW or a
    ///         pending request, so (2) alone reads as "nothing done" and would mint a whole new
    ///         batch of USDW that never gets deposited (`requestLpDeposit`'s own
    ///         `currentBalance() > 0` fallback correctly refuses to request it) — wasteful, and
    ///         it is exactly what `test_everyStepIsIdempotent` (run the full sequence twice)
    ///         catches by asserting `USDW.totalSupply()` is unchanged on the second pass.
    ///      2. `balanceOf(c.lp) + pendingDepositRequest(c.lp, id) >= c.lpAmount` — what the LP
    ///         already holds PLUS what it already committed to the *current* target settlement.
    ///         Needed for the narrower mid-cycle case (1) does not cover: resumed strictly
    ///         between a successful `requestDeposit` and the following `forceSettlement`, where
    ///         `currentBalance()` is still zero (settlement is what mints the escrowed shares —
    ///         see `requestLpDeposit`'s comment) but the LP's balance already moved into
    ///         `pendingDepositRequest`. Without (2), that balance-only read is zero and this
    ///         would mint a second `c.lpAmount`, even though nothing was lost; combined with
    ///         `requestLpDeposit`'s own idempotency check that would then let a *second*
    ///         `requestDeposit` succeed instead of correctly failing on insufficient balance,
    ///         doubling the vault's liquidity.
    function mintToLp(Config memory c) public {
        USDW usdw = USDW(c.usdw);
        OstiumVault vault = OstiumVault(c.vault);
        if (vault.currentBalance() > 0) return;
        uint32 id = vault.targetSettlementId(true);
        if (usdw.balanceOf(c.lp) + vault.pendingDepositRequest(c.lp, id) >= c.lpAmount) return;
        _relay(msg.sender);
        usdw.mint(c.lp, c.lpAmount);
    }

    /// @notice Requests an LP deposit of `c.lpAmount` into the vault.
    /// @dev Caller must be `c.lp`. The approve target is the vault itself, because
    ///      `OstiumVault.requestDeposit` executes `safeTransferFrom` from inside its own code,
    ///      making the vault the ERC-20 `msg.sender` for that transfer.
    ///
    ///      `currentBalance()` only becomes non-zero once `settle()` mints shares into the
    ///      vault's own escrow (`OstiumVault.sol:608-654`) — it is zero for the whole window
    ///      between a successful `requestDeposit` and the following `forceSettlement`. Skipping
    ///      solely on `currentBalance() > 0` would therefore re-request (and double-pull USDW
    ///      from the LP) on a run resumed inside that window. Instead: resume by returning the
    ///      already-established settlement id whenever a request for it already exists
    ///      (`getDepositStatus != NONE` covers PENDING, CLAIMABLE and RECLAIMABLE alike), and
    ///      only fall back to the `currentBalance()` check — "nothing pending for the current
    ///      target id, and the vault already has liquidity from an earlier cycle" — once no
    ///      request is outstanding.
    function requestLpDeposit(Config memory c) public returns (uint32 settlementId) {
        IOstiumVault vault = IOstiumVault(c.vault);
        settlementId = vault.targetSettlementId(true);

        if (vault.getDepositStatus(c.lp, settlementId) != IOstiumVault.RequestStatus.NONE) {
            return settlementId; // already requested; resume instead of re-requesting
        }
        if (vault.currentBalance() > 0) return 0; // nothing pending, and liquidity already landed

        _relay(msg.sender);
        IERC20(c.usdw).approve(c.vault, c.lpAmount);

        _relay(msg.sender);
        vault.requestDeposit(c.lpAmount);
    }

    /// @notice Forces settlement so the pending LP deposit converts into claimable shares.
    /// @dev Caller must be `registry.gov()` (checked by `OstiumVault`'s `onlyGov`).
    ///      `maxSettlementInterval` is 86400s, so this is the escape hatch instead of waiting a
    ///      day for a natural settlement. Skipped once `currentBalance() > 0`.
    function settle(Config memory c) public {
        IOstiumVault vault = IOstiumVault(c.vault);
        if (vault.currentBalance() > 0) return;
        _relay(msg.sender);
        vault.forceSettlement();
    }

    /// @notice Claims the LP's settled deposit shares.
    /// @dev Caller must be `c.lp`.
    ///
    ///      Skipping on `currentBalance() > 0` (as an earlier version did) is wrong: settlement
    ///      mints shares into the VAULT'S OWN escrow, not the LP's balance, so
    ///      `currentBalance()` — which counts `totalSupply()` regardless of holder — is already
    ///      non-zero the moment `settle()` returns, before this function ever runs. That made
    ///      `claimDeposit` unreachable on every path: the LP's shares stayed escrowed at the
    ///      vault's own address and `pendingDepositRequest[c.lp][settlementId]` was never
    ///      cleared. The correct "already done?" read is the LP's OWN claim status:
    ///      `getDepositStatus` returns CLAIMABLE only after settlement has processed this
    ///      exact `settlementId` for this exact owner (`OstiumVault.sol:577-584`).
    ///
    ///      `settlementId == 0` means this was resumed by a fresh process after a *different*
    ///      call to `requestLpDeposit` already fell through to its `currentBalance() > 0` branch
    ///      — which happens whenever a run dies strictly between `settle()` and
    ///      `claimLpDeposit()`: `settle()` already advanced `lastSettlementId`, so the resumed
    ///      `requestLpDeposit` reads `targetSettlementId(true) == lastSettlementId + 1`, finds
    ///      nothing pending at that new id, and correctly returns 0 (nothing new to request).
    ///      Passing that 0 straight through used to read `getDepositStatus(c.lp, 0)`, which is
    ///      always NONE (nothing was ever requested at id 0) — so the claim silently never
    ///      happened and never self-healed, stranding the LP's shares at the vault's own escrow
    ///      forever (the status has no expiry, but nothing else surfaces the problem either).
    ///      Derive the actual id instead: `targetSettlementId(true) - 1 == lastSettlementId`, the
    ///      id `settle()` most recently processed. No underflow — `targetSettlementId(true) =
    ///      lastSettlementId + 1 >= 1` always. On the clean two-pass case (nothing left to claim)
    ///      this derived id's `pendingDepositRequest` was already cleared by the first pass's
    ///      claim, so `getDepositStatus` reads NONE there too and this still correctly skips.
    function claimLpDeposit(Config memory c, uint32 settlementId) public {
        IOstiumVault vault = IOstiumVault(c.vault);
        uint32 id = settlementId == 0 ? vault.targetSettlementId(true) - 1 : settlementId; // == lastSettlementId
        if (vault.getDepositStatus(c.lp, id) != IOstiumVault.RequestStatus.CLAIMABLE) return;
        _relay(msg.sender);
        vault.claimDeposit(id);
    }

    /// @dev `contracts/foundry.toml`'s `fs_permissions` only allows reads under
    ///      `./script/config`, so `vm.readFile` cannot reach `$REPO/deployments/1874.json`
    ///      (verified empirically: `vm.readFile` reverts "is not allowed to be accessed for
    ///      read operations" for that path, relative or absolute) — and this task must not
    ///      edit `foundry.toml`. `docs/runbooks/deploy-testnet.md` already established the
    ///      workaround for `Deploy.s.sol`: extract `deployments/<chainid>.json` fields with
    ///      `node` *outside* forge and export them as env vars. `run()` follows the same
    ///      convention `Deploy.s.sol:run()` uses for its own role addresses (`vm.envAddress`).
    function _readConfig() internal view returns (Config memory) {
        return Config({
            registry: vm.envAddress("REGISTRY_ADDRESS"),
            usdw: vm.envAddress("USDW_ADDRESS"),
            pairsStorage: vm.envAddress("PAIRS_STORAGE_ADDRESS"),
            vault: vm.envAddress("VAULT_ADDRESS"),
            verifier: vm.envAddress("VERIFIER_ADDRESS"),
            priceUpKeep: vm.envAddress("PRICE_UPKEEP_ADDRESS"),
            signer: vm.envAddress("SIGNER_ADDRESS"),
            keeper: vm.envAddress("KEEPER_ADDRESS"),
            lp: vm.addr(vm.envUint("LP_PRIVATE_KEY")),
            lpAmount: vm.envUint("LP_AMOUNT")
        });
    }

    /// @notice Runs every configuration step against an already-deployed system, each under
    ///         its own broadcast because each needs a different sender.
    /// @dev `OWNER_PRIVATE_KEY` is the single key both `authoriseForwarder` and `mintToLp`
    ///      need: `Deploy.s.sol` hands both the registry's ownership (the `onlyTimelock`
    ///      resolution target) and `USDW`'s ownership to the same `owner` role.
    ///
    ///      IMPORTANT for whoever writes the next script that reuses these eight functions
    ///      (Task 4's live-position-opening driver, or anything else): call `OperateScript.run()`
    ///      itself, in-process — do not `new OperateScript()` from a *different* script and
    ///      wrap the individual functions (`addMarket`, `authoriseSigner`, ...) in your own
    ///      `vm.startBroadcast` from outside. That adds one more external-call hop, and
    ///      broadcast, like `vm.prank`, only attributes calls made directly by the broadcasting
    ///      contract — a call routed through a separate `OperateScript` instance would attribute
    ///      the nested vendor calls to that instance's address, not to the broadcaster's EOA,
    ///      silently breaking every `onlyGov`/`onlyTimelock` check on a live network. Verified
    ///      by the reviewer of this task against a live `anvil --broadcast`.
    function run() external {
        require(block.chainid == 1874, "unsupported chain");
        _broadcasting = true;

        Config memory c = _readConfig();
        uint256 govKey = vm.envUint("GOV_PRIVATE_KEY");
        uint256 ownerKey = vm.envUint("OWNER_PRIVATE_KEY");
        uint256 lpKey = vm.envUint("LP_PRIVATE_KEY");

        vm.startBroadcast(govKey);
        addMarket(c);
        vm.stopBroadcast();

        vm.startBroadcast(govKey);
        authoriseSigner(c);
        vm.stopBroadcast();

        vm.startBroadcast(ownerKey);
        authoriseForwarder(c);
        vm.stopBroadcast();

        vm.startBroadcast(govKey);
        registerUpkeep(c);
        vm.stopBroadcast();

        vm.startBroadcast(ownerKey);
        mintToLp(c);
        vm.stopBroadcast();

        vm.startBroadcast(lpKey);
        uint32 settlementId = requestLpDeposit(c);
        vm.stopBroadcast();

        vm.startBroadcast(govKey);
        settle(c);
        vm.stopBroadcast();

        vm.startBroadcast(lpKey);
        claimLpDeposit(c, settlementId);
        vm.stopBroadcast();
    }
}
