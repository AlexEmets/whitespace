// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Script} from "forge-std/Script.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {USDW} from "../src/mocks/USDW.sol";
import {IOstiumRegistry} from "../src/vendor/ostium/interfaces/IOstiumRegistry.sol";
import {IOstiumPairsStorage} from "../src/vendor/ostium/interfaces/IOstiumPairsStorage.sol";
import {IOstiumTradingStorage} from "../src/vendor/ostium/interfaces/IOstiumTradingStorage.sol";
import {IOstiumPairInfos} from "../src/vendor/ostium/interfaces/IOstiumPairInfos.sol";
import {IOstiumTradingCallbacks} from "../src/vendor/ostium/interfaces/IOstiumTradingCallbacks.sol";
import {IOstiumVerifier} from "../src/vendor/ostium/interfaces/IOstiumVerifier.sol";
import {IOstiumVault} from "../src/vendor/ostium/interfaces/IOstiumVault.sol";
import {IOstiumForwarded} from "../src/vendor/ostium/interfaces/IOstiumForwarded.sol";
import {OstiumVault} from "../src/vendor/ostium/OstiumVault.sol";
import {OstiumPairInfos} from "../src/vendor/ostium/OstiumPairInfos.sol";
import {OstiumTradesUpKeep} from "../src/vendor/ostium/OstiumTradesUpKeep.sol";
import {WhitespaceVerifier} from "../src/oracle/WhitespaceVerifier.sol";
import {WhitespacePriceUpKeep} from "../src/oracle/WhitespacePriceUpKeep.sol";

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

    /// @dev The same derivation, for markets whose oracle name is not known at compile time.
    ///      Reproduced rather than hardcoded per market because the vendored router and callbacks
    ///      will only ever ask the registry for THIS key — a market registered under a
    ///      hand-written key that differs by one character lists successfully, routes to
    ///      `NotFound`, and reverts only when the first trade tries to fetch a price.
    ///
    ///      `bytes32(bytes memory)` truncates past 32 bytes rather than reverting (Solidity's
    ///      explicit bytes→bytesNN conversion, allowed since 0.8.5), so the length is asserted:
    ///      an oracle name of 22 characters or more would silently collide with its own prefix.
    function _upkeepKey(string memory oracle) internal pure returns (bytes32) {
        bytes memory packed = abi.encodePacked(oracle, "PriceUpkeep");
        require(packed.length <= 32, "oracle name too long for a bytes32 registry key");
        return bytes32(packed);
    }

    /// @dev The pair's open-interest ceiling, PRECISION_6 (so $1,000,000). `openInterest[i][2]`
    ///      defaults to ZERO on a freshly listed pair, and `TradingCallbacksLib.withinExposureLimits`
    ///      compares `existingOi * price + collateral * leverage / 100` against it — so until this
    ///      is set, EVERY trade is silently cancelled with `CancelReason.EXPOSURE_LIMITS`. That
    ///      cancellation is not a revert: the open transaction succeeds and refunds the collateral
    ///      minus the oracle fee, leaving no position and no error to notice. Generous relative to
    ///      the 100,000 USDW vault, whose 20% `maxCollateralP` caps collateral at 20,000 anyway.
    uint256 internal constant PAIR_MAX_OI = 1_000_000e6;

    /// @dev PRECISION_18. Only has to be non-zero (it is a divisor) and satisfy
    ///      `springFactor * sFactorUpScaleP / 100e2 <= MAX_FR_SPRING_FACTOR = 1e18`.
    uint64 internal constant FUNDING_SPRING_FACTOR = 1e12;

    /// @dev Set by `run()`, once, before any of the eight functions execute. Distinguishes
    ///      "driven by `vm.startBroadcast`" from "driven by `vm.prank`" so `_relay` knows
    ///      whether it needs to do anything at all.
    bool internal _broadcasting;

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
            pairIndex = _findPairIndex(ps);
            _setFundingParams(c, pairIndex);
            return pairIndex;
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

        pairIndex = ps.pairsCount() - 1;
        _setFundingParams(c, pairIndex);
        return pairIndex;
    }

    /// @dev A freshly listed pair has an all-zero `PairFundingFeesV2`, and `springFactor` is a
    ///      DIVISOR in `OstiumPairInfos.getPendingAccFundingFees` — so the first trade on an
    ///      unconfigured pair panics with division-by-zero inside `storeTradeInitialAccFees`,
    ///      taking the whole `performUpkeep` delivery down with it. `addPair` does not set these,
    ///      so configuration must. Gated on the stored `springFactor` rather than on "we just
    ///      listed the pair", so a run that dies between `addPair` and here still heals.
    ///
    ///      `maxFundingFeePerBlock: 0` disables funding entirely, which is what this phase wants:
    ///      it keeps `targetFr` at zero, so the accumulator stays zero no matter how large
    ///      `block.number - lastUpdateBlock` is on a live chain. Everything else is the minimum
    ///      that satisfies `setPairFundingFees`' validation: `springFactor != 0`,
    ///      `springFactor * sFactorUpScaleP / 100e2 <= MAX_FR_SPRING_FACTOR (1e18)`,
    ///      `sFactorUpScaleP >= 100e2`, `sFactorDownScaleP <= 100e2`, and both hill scales
    ///      `<= MAX_HILL_SCALE (250)`.
    function _setFundingParams(Config memory c, uint16 pairIndex) internal {
        IOstiumPairInfos pairInfos =
            IOstiumPairInfos(IOstiumRegistry(c.registry).getContractAddress("pairInfos"));
        // Through the concrete contract: the interface getter is not `view`, so under
        // `--broadcast` this read would be sent as a transaction.
        (,,,,, uint64 springFactor,,,,,,) = OstiumPairInfos(address(pairInfos)).pairFundingFees(pairIndex);
        if (springFactor != 0) return;

        _relay(msg.sender);
        pairInfos.setPairFundingFees(
            pairIndex,
            IOstiumPairInfos.PairFundingFeesV2({
                accPerOiLong: 0,
                accPerOiShort: 0,
                lastFundingRate: 0,
                hillInflectionPoint: 0,
                maxFundingFeePerBlock: 0,
                springFactor: FUNDING_SPRING_FACTOR,
                lastUpdateBlock: 0,
                hillPosScale: 100,
                hillNegScale: 100,
                sFactorUpScaleP: 100_00,
                sFactorDownScaleP: 100_00,
                lastOiDelta: 0
            })
        );
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

    /// @notice Lets the vault pull settled losses and fees out of the callbacks contract.
    /// @dev Caller must be `registry.gov()` (`setVaultMaxAllowance` is `onlyGov`).
    ///      `OstiumVault.receiveAssets` does `transferFrom(callbacks, vault, amount)`, so without
    ///      this allowance every CLOSE reverts `ERC20InsufficientAllowance` — opens succeed, which
    ///      makes it a trap: positions can be entered and then not exited. Nothing in
    ///      `Deploy.s.sol` sets it, because the vault address is only knowable after both are
    ///      deployed.
    function approveVaultAllowance(Config memory c) public {
        IOstiumRegistry registry = IOstiumRegistry(c.registry);
        address callbacks = registry.getContractAddress("callbacks");
        if (IERC20(c.usdw).allowance(callbacks, c.vault) > 0) return;
        _relay(msg.sender);
        IOstiumTradingCallbacks(callbacks).setVaultMaxAllowance();
    }

    /// @notice Lifts the pair's open-interest ceiling off zero, so trades can actually open.
    /// @dev Caller must be `registry.manager()` — `setMaxOpenInterest` is
    ///      `onlyManagerOrMaxOIKeeper`, and no max-OI keeper is configured by `Deploy.s.sol`.
    ///      `tradingStorage` is resolved through the registry rather than added to `Config`,
    ///      matching how the vendored contracts locate each other.
    function setMaxOi(Config memory c, uint16 pairIndex) public {
        IOstiumTradingStorage ts =
            IOstiumTradingStorage(IOstiumRegistry(c.registry).getContractAddress("tradingStorage"));
        if (ts.openInterest(pairIndex, 2) > 0) return;
        _relay(msg.sender);
        ts.setMaxOpenInterest(pairIndex, PAIR_MAX_OI);
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

    // =======================================================================================
    // Phase 2 — oracle hardening
    //
    // Four more functions in the same shape as the eight above: one `msg.sender` role each,
    // each opening with a read that answers "already done?". They MIGRATE an already-deployed
    // and already-configured system (which chain 1874 is) from the vendored single-signer
    // oracle to the hardened k-of-N one, so every one of them resolves its target through the
    // registry rather than through `Config` — the registry is the single source of truth for
    // which verifier and which upkeep the vendored contracts will actually call.
    //
    // ORDER MATTERS, but only for how long the window of mismatch lasts, not for safety.
    // `WhitespaceVerifier` returns a NINE-field `reportData`; the vendored upkeep decodes SEVEN.
    // Between the two installs the pair is mismatched — and it fails CLOSED in both directions:
    // a hardened upkeep asking the vendored verifier to parse `abi.encode(bytes, bytes[])`
    // recovers a garbage signer and reverts `NotAuthorizedSigner`; a vendored upkeep decoding a
    // nine-field payload as seven reverts in the ABI decoder when the 20-byte verifier address
    // fails to fit the `uint32 timestamp` slot. No mismatched combination delivers a price.
    // In-flight orders simply time out and traders reclaim via `openTradeMarketTimeout`.
    // =======================================================================================

    bytes32 internal constant VERIFIER_KEY = "ostiumVerifier";

    /// @param registry        The system registry. Everything else is resolved through it.
    /// @param signers         The N authorised report signers. Registration order is irrelevant;
    ///                        ascending order is a per-report requirement, not a per-signer one.
    /// @param threshold       k. Initial: 3 of N=5.
    /// @param guardian        May pause the upkeep and halt feeds immediately; cannot restart.
    /// @param keeper          The forwarder allowed to call `performUpkeep`.
    /// @param maxAge          Rail 1, seconds. Initial: 10.
    /// @param maxDeviationBps Rail 2, basis points vs the feed's last accepted price. Initial: 500.
    struct OracleConfig {
        address registry;
        address[] signers;
        uint256 threshold;
        address guardian;
        address keeper;
        uint32 maxAge;
        uint16 maxDeviationBps;
    }

    /// @notice Deploys `WhitespaceVerifier` and points the registry's `ostiumVerifier` key at it.
    /// @dev Caller must be `registry.gov()` (`registerContract`/`updateContract` are `onlyGov`).
    ///      Idempotent on the registry read: if the key already resolves to a hardened verifier
    ///      this deploys nothing and returns the incumbent, so a resumed run does not orphan a
    ///      working verifier (and does not spend a deployment's worth of gas re-doing it).
    ///
    ///      The constructor seeds the signer set, because the deploying account is not gov and
    ///      an unseeded verifier accepts nothing. Gov's adoption of the address IS the trust
    ///      decision — read `signerCount`/`threshold` off the instance before believing it.
    function installHardenedVerifier(OracleConfig memory c) public returns (address verifier) {
        IOstiumRegistry registry = IOstiumRegistry(c.registry);
        (bool found, address current) = _lookup(registry, VERIFIER_KEY);
        if (found && _isHardenedVerifier(current)) return current;

        verifier = address(new WhitespaceVerifier(registry, c.signers, c.threshold));

        _relay(msg.sender);
        if (found) registry.updateContract(VERIFIER_KEY, verifier);
        else registry.registerContract(VERIFIER_KEY, verifier);
    }

    /// @notice Reconciles the verifier's signer set and threshold with `c`.
    /// @dev Caller must be `registry.gov()`. Separate from `installHardenedVerifier` because it
    ///      is the only path that heals a verifier which already exists but whose signer set has
    ///      drifted (a key rotated, a signer added) — the install path returns early in exactly
    ///      that case. Additive only: it never unregisters a signer, because removing one is a
    ///      decision about a suspected compromise and must not happen as a side effect of a
    ///      configuration replay.
    function authoriseHardenedSigners(OracleConfig memory c) public {
        WhitespaceVerifier verifier = WhitespaceVerifier(_requireHardenedVerifier(c.registry));

        for (uint256 i = 0; i < c.signers.length; i++) {
            if (verifier.isAuthorizedSigner(c.signers[i])) continue;
            _relay(msg.sender);
            verifier.registerAuthorizedSigner(c.signers[i]);
        }

        if (verifier.threshold() == c.threshold) return;
        _relay(msg.sender);
        verifier.setThreshold(c.threshold);
    }

    /// @notice Single-feed form: installs the hardened upkeep under BTC/USD's key only.
    /// @dev Preserved as an overload so every existing caller keeps compiling and keeps its
    ///      original meaning. New callers that list more than one market use the array form.
    function installHardenedUpkeep(OracleConfig memory c) public returns (address upkeep) {
        bytes32[] memory feedKeys = new bytes32[](1);
        feedKeys[0] = PRICE_UPKEEP_KEY;
        return installHardenedUpkeep(c, feedKeys);
    }

    /// @notice Deploys `WhitespacePriceUpKeep` once and points every per-oracle registry key in
    ///         `feedKeys` at that same instance.
    /// @dev Caller must be `registry.gov()`. Handles both live states per key: absent (a system
    ///      where `registerUpkeep` never ran) and holding the vendored upkeep (the 1874
    ///      deployment) — `registerContract` reverts `AlreadyRegistered` on the second, so the
    ///      branch is not cosmetic.
    ///
    ///      ONE instance serves every feed, deliberately. The two pieces of per-market state the
    ///      upkeep owns are already keyed by feed inside the contract — `isFeedHalted[feedId]`
    ///      and the deviation baseline `lastPrice[feedId]` — so a second deployment would
    ///      fragment that state across instances, cost another deployment's gas, and give the
    ///      guardian two `pause()` switches where the design specifies one. Reuse whatever any
    ///      of the keys already resolves to, so adding a market to a live system deploys nothing.
    ///
    ///      Deployed directly, not behind an `ERC1967Proxy` as `Deploy.s.sol` does for the
    ///      vendored upkeep: nothing in `src/vendor/` is UUPS, so those proxies cannot be
    ///      upgraded and buy only an extra DELEGATECALL per delivery. See the contract's header.
    function installHardenedUpkeep(OracleConfig memory c, bytes32[] memory feedKeys)
        public
        returns (address upkeep)
    {
        require(feedKeys.length > 0, "installHardenedUpkeep: no feed keys");
        IOstiumRegistry registry = IOstiumRegistry(c.registry);

        for (uint256 i = 0; i < feedKeys.length; i++) {
            (bool found, address current) = _lookup(registry, feedKeys[i]);
            if (found && _isHardenedUpkeep(current)) {
                upkeep = current;
                break;
            }
        }
        if (upkeep == address(0)) {
            upkeep = address(new WhitespacePriceUpKeep(registry, c.guardian));
        }

        for (uint256 i = 0; i < feedKeys.length; i++) {
            (bool found, address current) = _lookup(registry, feedKeys[i]);
            if (found && current == upkeep) continue;
            _relay(msg.sender);
            if (found) registry.updateContract(feedKeys[i], upkeep);
            else registry.registerContract(feedKeys[i], upkeep);
        }
    }

    /// @notice Allowlists `c.keeper` as a forwarder on the hardened upkeep.
    /// @dev Caller must be `IOwnable(c.registry).owner()` — `registerForwarder` is
    ///      `onlyTimelock`, same as on the vendored upkeep. Separate from `authoriseForwarder`
    ///      rather than a `Config` field swap, because it is a different contract instance and
    ///      the two upkeeps are allowlisted independently: forwarding rights on the retired one
    ///      are deliberately not carried over.
    function authoriseHardenedForwarder(OracleConfig memory c) public {
        IOstiumForwarded upkeep = IOstiumForwarded(_requireHardenedUpkeep(c.registry));
        if (upkeep.isForwarder(c.keeper)) return;
        _relay(msg.sender);
        upkeep.registerForwarder(c.keeper);
    }

    /// @notice Brings the upkeep's rail parameters and guardian in line with `c`.
    /// @dev Caller must be `registry.gov()` — every parameter setter on the upkeep is `onlyGov`;
    ///      the guardian's powers are limited to `pause`/`haltFeed`, never to configuration.
    ///      Each of the three is compared before it is written, so a replay sends zero
    ///      transactions. The constructor already applies the spec defaults (10 s / 500 bps), so
    ///      this is a no-op on a fresh install configured with those same values.
    function configureOracleRails(OracleConfig memory c) public {
        WhitespacePriceUpKeep upkeep = WhitespacePriceUpKeep(_requireHardenedUpkeep(c.registry));

        if (upkeep.maxAge() != c.maxAge) {
            _relay(msg.sender);
            upkeep.setMaxAge(c.maxAge);
        }
        if (upkeep.maxDeviationBps() != c.maxDeviationBps) {
            _relay(msg.sender);
            upkeep.setMaxDeviationBps(c.maxDeviationBps);
        }
        if (upkeep.guardian() != c.guardian) {
            _relay(msg.sender);
            upkeep.setGuardian(c.guardian);
        }
    }

    /// @dev `getContractAddress` reverts `NotFound` rather than returning zero, so "is this key
    ///      set?" is a try/catch on the read — the same shape `registerUpkeep` already uses.
    function _lookup(IOstiumRegistry registry, bytes32 key)
        internal
        view
        returns (bool found, address addr)
    {
        try registry.getContractAddress(key) returns (address a) {
            return (true, a);
        } catch {
            return (false, address(0));
        }
    }

    /// @dev Distinguishes a hardened instance from the vendored one by probing for a getter only
    ///      the hardened one has. `OstiumVerifier` has no `threshold()` and no fallback, so the
    ///      staticcall reverts there. Deliberately low-level rather than `try/catch`: a
    ///      `try` statement does not catch a return-data DECODING failure, so a contract
    ///      answering that selector with short data would take the whole run down instead of
    ///      being classified as "not hardened". `abi.encodeCall` against the instance getter
    ///      keeps the selector compiler-checked, so renaming `threshold` breaks the build rather
    ///      than silently making every install non-idempotent.
    function _isHardenedVerifier(address a) internal view returns (bool) {
        (bool ok, bytes memory ret) = a.staticcall(abi.encodeCall(WhitespaceVerifier(a).threshold, ()));
        return ok && ret.length == 32;
    }

    /// @dev Same probe for the upkeep. `OstiumPrivatePriceUpKeep` has no `maxAge()`.
    function _isHardenedUpkeep(address a) internal view returns (bool) {
        (bool ok, bytes memory ret) = a.staticcall(abi.encodeCall(WhitespacePriceUpKeep(a).maxAge, ()));
        return ok && ret.length == 32;
    }

    function _requireHardenedVerifier(address registry) internal view returns (address verifier) {
        (bool found, address current) = _lookup(IOstiumRegistry(registry), VERIFIER_KEY);
        require(found && _isHardenedVerifier(current), "hardened verifier not installed");
        return current;
    }

    function _requireHardenedUpkeep(address registry) internal view returns (address upkeep) {
        (bool found, address current) = _lookup(IOstiumRegistry(registry), PRICE_UPKEEP_KEY);
        require(found && _isHardenedUpkeep(current), "hardened upkeep not installed");
        return current;
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
        uint256 managerKey = vm.envUint("MANAGER_PRIVATE_KEY");

        vm.startBroadcast(govKey);
        uint16 pairIndex = addMarket(c);
        vm.stopBroadcast();

        vm.startBroadcast(managerKey);
        setMaxOi(c, pairIndex);
        vm.stopBroadcast();

        vm.startBroadcast(govKey);
        approveVaultAllowance(c);
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

    /// @dev Rail defaults, applied when the operator does not override them. Same values as the
    ///      upkeep's own constructor defaults and as design spec §5.2, restated here so
    ///      `configureOracleRails` has something concrete to compare against instead of
    ///      silently accepting whatever the contract happened to be deployed with.
    uint256 internal constant DEFAULT_ORACLE_MAX_AGE = 10;
    uint256 internal constant DEFAULT_ORACLE_MAX_DEVIATION_BPS = 500;

    function _readOracleConfig() internal view returns (OracleConfig memory) {
        return OracleConfig({
            registry: vm.envAddress("REGISTRY_ADDRESS"),
            signers: vm.envAddress("ORACLE_SIGNERS", ","),
            threshold: vm.envUint("ORACLE_THRESHOLD"),
            guardian: vm.envAddress("GUARDIAN_ADDRESS"),
            keeper: vm.envAddress("KEEPER_ADDRESS"),
            maxAge: uint32(vm.envOr("ORACLE_MAX_AGE", DEFAULT_ORACLE_MAX_AGE)),
            maxDeviationBps: uint16(vm.envOr("ORACLE_MAX_DEVIATION_BPS", DEFAULT_ORACLE_MAX_DEVIATION_BPS))
        });
    }

    /// @dev `ORACLE_FEEDS` is a comma-separated list of ORACLE NAMES, not registry keys — e.g.
    ///      `ORACLE_FEEDS=BTC/USD,ETH/USD`. The operator writes the same string that goes into
    ///      `Pair.oracle`, and `_upkeepKey` performs the one derivation the vendored contracts
    ///      perform, so the two cannot drift. Defaults to BTC/USD alone, which is what 1874 has
    ///      listed today: an unset variable therefore reproduces the pre-existing behaviour
    ///      exactly rather than silently registering nothing.
    function _readOracleFeedKeys() internal view returns (bytes32[] memory keys) {
        string[] memory defaultFeeds = new string[](1);
        defaultFeeds[0] = PAIR_ORACLE;

        string[] memory oracles = vm.envOr("ORACLE_FEEDS", ",", defaultFeeds);
        keys = new bytes32[](oracles.length);
        for (uint256 i = 0; i < oracles.length; i++) {
            keys[i] = _upkeepKey(oracles[i]);
        }
    }

    // =======================================================================================
    // Phase D — liquidation
    //
    // `Deploy.s.sol` never deploys `OstiumTradesUpKeep`, and `OstiumTrading.sol:123` gates the
    // liquidation entrypoint on `msg.sender == registry.getContractAddress('tradesUpKeep')`.
    // With that key unset the comparison can only ever fail, so on the deployed 1874 system
    // NO address — not gov, not the owner, not a bot — can liquidate an underwater position.
    // The vendored contract exists and is sound; it was simply never installed.
    //
    // That is not a cosmetic gap. The LP vault is the counterparty to every position, so an
    // unliquidatable position that keeps losing is a position whose losses the vault absorbs
    // past the collateral that was supposed to cover them.
    // =======================================================================================

    bytes32 internal constant TRADES_UPKEEP_KEY = "tradesUpKeep";

    /// @param registry   The system registry. The upkeep resolves everything else through it.
    /// @param liquidator The forwarder allowed to call `performUpkeep`. Liquidation here is
    ///                   allowlisted, not permissionless — see `OstiumTradesUpKeep.sol:55`.
    struct LiquidationConfig {
        address registry;
        address liquidator;
    }

    /// @dev Behind an `ERC1967Proxy` because `OstiumTradesUpKeep` is `initializer`-based with a
    ///      disabled constructor — unlike the two hardened oracle contracts, which are ours and
    ///      take constructor arguments. Same shape `Deploy.s.sol` uses for every vendored
    ///      contract, so this one is not an exception to how the system is assembled.
    function _proxy(address implementation, bytes memory initCall) internal returns (address) {
        return address(new ERC1967Proxy(implementation, initCall));
    }

    /// @notice Deploys `OstiumTradesUpKeep` and registers it under the `tradesUpKeep` key.
    /// @dev Caller must be `registry.gov()`. Idempotent on the registry read: a replayed run
    ///      neither redeploys nor re-registers, because re-pointing the key would silently
    ///      strip the forwarder allowlist the incumbent had accumulated.
    function installTradesUpKeep(LiquidationConfig memory c) public returns (address upkeep) {
        IOstiumRegistry registry = IOstiumRegistry(c.registry);
        (bool found, address current) = _lookup(registry, TRADES_UPKEEP_KEY);
        if (found && current != address(0)) return current;

        upkeep = _proxy(
            address(new OstiumTradesUpKeep()),
            abi.encodeCall(OstiumTradesUpKeep.initialize, (registry))
        );

        _relay(msg.sender);
        registry.registerContract(TRADES_UPKEEP_KEY, upkeep);
    }

    /// @notice Allowlists `c.liquidator` as a forwarder on the trades upkeep.
    /// @dev Caller must be `IOwnable(c.registry).owner()` — `registerForwarder` is
    ///      `onlyTimelock` (`OstiumTradesUpKeep.sol:74`), the same authority the price
    ///      upkeep's forwarder list requires.
    function authoriseLiquidator(LiquidationConfig memory c) public {
        OstiumTradesUpKeep upkeep = OstiumTradesUpKeep(payable(_requireTradesUpKeep(c.registry)));
        if (upkeep.isForwarder(c.liquidator)) return;
        _relay(msg.sender);
        upkeep.registerForwarder(c.liquidator);
    }

    function _requireTradesUpKeep(address registry) internal view returns (address upkeep) {
        (bool found, address current) = _lookup(IOstiumRegistry(registry), TRADES_UPKEEP_KEY);
        require(found && current != address(0), "trades upkeep not installed");
        return current;
    }

    /// @notice Installs the trades upkeep and allowlists the liquidator. Separate entrypoint
    ///         for the same reason `runOracle()` is one: different preconditions, and folding
    ///         it into `run()` would invalidate the env block already recorded in
    ///         `docs/runbooks/deploy-testnet.md`.
    function runLiquidation() external {
        require(block.chainid == 1874, "unsupported chain");
        _broadcasting = true;

        LiquidationConfig memory c = LiquidationConfig({
            registry: vm.envAddress("REGISTRY_ADDRESS"),
            liquidator: vm.envAddress("LIQUIDATOR_ADDRESS")
        });
        uint256 govKey = vm.envUint("GOV_PRIVATE_KEY");
        uint256 ownerKey = vm.envUint("OWNER_PRIVATE_KEY");

        vm.startBroadcast(govKey);
        installTradesUpKeep(c);
        vm.stopBroadcast();

        vm.startBroadcast(ownerKey);
        authoriseLiquidator(c);
        vm.stopBroadcast();
    }

    /// @notice Migrates a deployed system from the vendored single-signer oracle to the
    ///         hardened k-of-N one. Separate entrypoint from `run()`, invoked with
    ///         `forge script ... --sig "runOracle()"`.
    /// @dev A separate entrypoint rather than five more steps inside `run()`, for two reasons.
    ///      `run()` is documented in `docs/runbooks/deploy-testnet.md` with an exact env-var
    ///      block that has already been executed against 1874; adding four required variables to
    ///      it would silently invalidate that recorded procedure. And the two operations have
    ///      genuinely different preconditions — `run()` configures a market that does not exist
    ///      yet, this one replaces the oracle under a market that is already trading.
    ///
    ///      Needs only two keys: gov for four of the five steps, and the registry `owner()`
    ///      (what `onlyTimelock` resolves to here) for the forwarder allowlist.
    ///
    ///      `ORACLE_SIGNERS` is a comma-separated address list, e.g.
    ///      `ORACLE_SIGNERS=0xaaa...,0xbbb...,0xccc...,0xddd...,0xeee...`.
    ///
    ///      `ORACLE_FEEDS` is a comma-separated list of oracle names, e.g.
    ///      `ORACLE_FEEDS=BTC/USD,ETH/USD`, and every one of them is pointed at the single
    ///      upkeep instance this run installs. Optional; defaults to BTC/USD alone.
    function runOracle() external {
        require(block.chainid == 1874, "unsupported chain");
        _broadcasting = true;

        OracleConfig memory c = _readOracleConfig();
        bytes32[] memory feedKeys = _readOracleFeedKeys();
        uint256 govKey = vm.envUint("GOV_PRIVATE_KEY");
        uint256 ownerKey = vm.envUint("OWNER_PRIVATE_KEY");

        vm.startBroadcast(govKey);
        installHardenedVerifier(c);
        vm.stopBroadcast();

        vm.startBroadcast(govKey);
        authoriseHardenedSigners(c);
        vm.stopBroadcast();

        vm.startBroadcast(govKey);
        installHardenedUpkeep(c, feedKeys);
        vm.stopBroadcast();

        vm.startBroadcast(ownerKey);
        authoriseHardenedForwarder(c);
        vm.stopBroadcast();

        vm.startBroadcast(govKey);
        configureOracleRails(c);
        vm.stopBroadcast();
    }

    // =======================================================================================
    // Phase E — additional markets
    //
    // `addMarket()` above lists exactly one pair, because every field it writes is a file-scope
    // constant (`PAIR_FROM` … `PAIR_MAX_LEVERAGE`). Listing ETH/USD or SOL/USD through it would
    // mean editing those constants — i.e. changing the meaning of a function that has already
    // run against 1874. The three functions below are the same on-chain steps with those
    // constants lifted into arguments, plus the one step `addMarket()` never had to think about:
    // the per-oracle upkeep registry key, which is a constant only while there is one market.
    //
    // Nothing here refactors the twelve functions above. `addMarket`, `setMaxOi` and
    // `registerUpkeep` keep their exact bodies and their exact meaning, because the env block in
    // `docs/runbooks/deploy-testnet.md` was executed against 1874 with them, and a "harmless"
    // generalisation of code that has run on a live chain is an unreviewed edit to a recorded
    // procedure.
    //
    // ORDER, per market: register the upkeep key FIRST, then list the pair, then lift its OI
    // ceiling. Registering a key for a pair that does not exist yet is inert — nothing resolves
    // `<oracle>PriceUpkeep` until some pair carries that oracle string — whereas the reverse
    // order leaves a window in which the pair is listed and `OstiumPriceRouter.sol:81-84` cannot
    // resolve its upkeep, so every `openTrade` on it reverts `NotFound` inside
    // `OstiumRegistry.sol:118-121`. That window is loud rather than lossy, but it is free not to
    // have.
    //
    // NOT per-pair, and therefore not repeated here: `approveVaultAllowance` (one allowance on
    // the one collateral token, `OstiumTradingCallbacks.setVaultMaxAllowance`) and the LP
    // deposit. Both are properties of the system, both are already satisfied on 1874 — but note
    // that `groupMaxCollateral` (`OstiumPairsStorage.sol:268-271`) is
    // `maxCollateralP * vault.currentBalance() / 100_00`, so a vault drained to zero silently
    // cancels every trade on EVERY market in the group, new ones included.
    // =======================================================================================

    /// @param registry    The system registry. `pairsStorage`, `pairInfos` and `tradingStorage`
    ///                    are all resolved through it — the way the vendored contracts locate
    ///                    each other (`OstiumPriceRouter.sol:81`) and the way `setMaxOi` above
    ///                    already does — so it is the only address the operator supplies.
    /// @param name        The market as ONE string, e.g. `"ETH/USD"`. `from`, `to`, `feed` and
    ///                    `oracle` are all DERIVED from it rather than supplied separately,
    ///                    because those four fields are not independent and every way they can
    ///                    disagree fails late or silently:
    ///                      - `feed` must equal the `feedId` the publisher signs, or delivery
    ///                        reverts `InvalidPrice` at `WhitespacePriceUpKeep.sol:223`. On the
    ///                        off-chain side that id is `asciiToBytes32Hex('ETH/USD')`
    ///                        (`packages/shared/src/markets.mjs`), which is byte-identical to
    ///                        Solidity's `bytes32("ETH/USD")`.
    ///                      - `oracle` alone determines the upkeep registry key
    ///                        (`OstiumPriceRouter.sol:81-84`), and a key that differs by one
    ///                        character lists cleanly and only fails at the first trade.
    ///                      - `from`/`to` are re-joined as `` `${from}/${to}` `` by
    ///                        `services/api/src/publisher.ts:106-108` to find a market row's
    ///                        publisher feed; if that string is not the feed name, `/price`
    ///                        silently degrades to the stale on-chain path with no error.
    ///                    One source string makes all three agree by construction.
    /// @param maxLeverage PRECISION_2, so `10_000` is 100.00x. Must be `<= MAX_LEVERAGE`
    ///                    (100000) and `>= groups[groupIndex].minLeverage`, per `_pairOk`
    ///                    (`OstiumPairsStorage.sol:107-117`). Zero is legal and means "inherit
    ///                    the group's `maxLeverage`" (`OstiumPairsStorage.sol:262-266`).
    /// @param maxOi       PRECISION_6 open-interest ceiling. Zero is the trap `setMaxOi`
    ///                    documents at length: trades are CANCELLED, not reverted.
    /// @param groupIndex  Existing group. Not created here — see `addMarketFor`.
    /// @param feeIndex    Existing fee tier. Not created here — see `addMarketFor`.
    struct MarketConfig {
        address registry;
        string name;
        uint32 maxLeverage;
        uint256 maxOi;
        uint8 groupIndex;
        uint8 feeIndex;
    }

    /// @dev Splits `"ETH/USD"` into `bytes32("ETH")` and `bytes32("USD")`.
    ///
    ///      `bytes32(bytes memory)` left-aligns and zero-pads exactly as the literal
    ///      `bytes32("ETH")` does — the same explicit bytes→bytesNN conversion `_upkeepKey`
    ///      above relies on — but it TRUNCATES past 32 bytes instead of reverting, so both
    ///      halves are length-checked rather than trusted.
    ///
    ///      Exactly one `/` is required. Zero would leave `to` empty and list a pair whose `to`
    ///      is `bytes32(0)`; two would make the split ambiguous. Neither is caught by `addPair`,
    ///      which validates leverage and nothing else (`OstiumPairsStorage.sol:142-160`), so it
    ///      is caught here — before a transaction is built, not after a market is live.
    ///
    ///      The whole name is bounded to 32 bytes as well, not just each half: it is also used
    ///      whole as the `feed`, where the same silent truncation applies, and its JS counterpart
    ///      `asciiToBytes32Hex` throws past 32 bytes rather than truncating — so the two sides
    ///      agree on rejection, not just on encoding.
    ///
    ///      Spaces and control characters are rejected outright. `MARKETS` is a comma-separated
    ///      env string, and `vm.envString` does not trim, so `MARKETS=ETH/USD, SOL/USD` yields a
    ///      second entry of `" SOL/USD"` — which is a perfectly listable market whose `from` is
    ///      `" SOL"`, whose feed no publisher will ever sign, and whose registry key differs from
    ///      the one anybody would later look for. That is a whole-run silent failure caused by a
    ///      space, so it fails here instead.
    function _splitFeedName(string memory name) internal pure returns (bytes32 from, bytes32 to) {
        bytes memory raw = bytes(name);
        require(raw.length <= 32, "market name must fit in bytes32 to be used as the feed id");

        uint256 slash = type(uint256).max;
        for (uint256 i = 0; i < raw.length; i++) {
            require(raw[i] > bytes1(0x20), "market name must not contain spaces or control characters");
            if (raw[i] != bytes1("/")) continue;
            require(slash == type(uint256).max, "market name has more than one '/'");
            slash = i;
        }
        require(slash != type(uint256).max, "market name must be '<FROM>/<TO>'");

        uint256 toLength = raw.length - slash - 1;
        require(slash > 0 && slash <= 32, "market base symbol must be 1-32 bytes");
        require(toLength > 0 && toLength <= 32, "market quote symbol must be 1-32 bytes");

        bytes memory fromBytes = new bytes(slash);
        for (uint256 i = 0; i < slash; i++) {
            fromBytes[i] = raw[i];
        }
        bytes memory toBytes = new bytes(toLength);
        for (uint256 i = 0; i < toLength; i++) {
            toBytes[i] = raw[slash + 1 + i];
        }

        return (bytes32(fromBytes), bytes32(toBytes));
    }

    /// @dev The parameterised twin of `_findPairIndex`: same linear scan, same reason (there is
    ///      no reverse (from,to) -> index lookup in `OstiumPairsStorage`), but for a pair whose
    ///      symbols are not known at compile time. Written as a twin rather than folded into
    ///      `_findPairIndex` so that function — reached from `addMarket` on the idempotent skip
    ///      path — keeps its exact body and its exact revert string.
    function _findPairIndexFor(IOstiumPairsStorage ps, bytes32 from, bytes32 to)
        internal
        view
        returns (uint16)
    {
        uint16 count = ps.pairsCount();
        for (uint16 i = 0; i < count; i++) {
            (bytes32 pairFrom, bytes32 pairTo,,,,,,,) = ps.pairs(i);
            if (pairFrom == from && pairTo == to) {
                return i;
            }
        }
        revert("pair not found despite isPairListed() == true");
    }

    /// @notice Lists an arbitrary pair and configures its funding params, idempotently.
    /// @dev Caller must be `registry.gov()` — `addPair` is `onlyGov`
    ///      (`OstiumPairsStorage.sol:144`), as is `setPairFundingFees`.
    ///
    ///      Unlike `addMarket`, this does NOT lazily create the group and the fee tier. Any
    ///      system that has ever listed a market already has them (measured on 1874:
    ///      `groupsCount() == 1`, `feesCount() == 1`), and creating one here would mean a
    ///      SECOND group — with parameters nobody reviewed — appearing as a side effect of
    ///      adding a market. The two sentinels the contract itself uses are asserted instead, so
    ///      a misconfigured index names the missing thing rather than surfacing as the
    ///      vendored `GroupNotListed(index)`: `groupListed` is `groups[i].minLeverage != 0`
    ///      (`OstiumPairsStorage.sol:80-82`), `feeListed` is `fees[i].name != bytes32(0)`
    ///      (`:89-91`).
    ///
    ///      Sharing one group and one fee tier across every crypto market is the intended shape,
    ///      not a shortcut: `maxCollateralP` is a share of the ONE vault and `oracleFee` is a
    ///      property of the price pipeline, so both belong to the venue rather than to the pair.
    ///      `Fee.name` is `"BTC-USD"` for historical reasons and is read by nothing but that
    ///      non-zero check — a label, not a binding.
    ///
    ///      `tradeSizeRef: 0` and `overnightMaxLeverage: 0` match `addMarket`'s choices and are
    ///      both meaningful at zero: `tradeSizeRef` has no reader anywhere in `src/`, and
    ///      `overnightMaxLeverage == 0` means "no day/overnight distinction", which
    ///      `TradingLib.sol:28-31` resolves to `pairMaxLeverage` and `OstiumTrading.sol:227`
    ///      resolves to `isDayTrade = false`. Neither is a divisor.
    function addMarketFor(MarketConfig memory m) public returns (uint16 pairIndex) {
        IOstiumPairsStorage ps =
            IOstiumPairsStorage(IOstiumRegistry(m.registry).getContractAddress("pairsStorage"));
        (bytes32 from, bytes32 to) = _splitFeedName(m.name);

        (,, uint16 groupMinLeverage,) = ps.groups(m.groupIndex);
        require(groupMinLeverage != 0, "group not listed; add it before adding a market to it");
        (bytes32 feeName,,,) = ps.fees(m.feeIndex);
        require(feeName != bytes32(0), "fee tier not listed; add it before adding a market to it");

        if (ps.isPairListed(from, to)) {
            pairIndex = _findPairIndexFor(ps, from, to);
        } else {
            _relay(msg.sender);
            ps.addPair(
                IOstiumPairsStorage.Pair({
                    from: from,
                    to: to,
                    feed: bytes32(bytes(m.name)),
                    tradeSizeRef: 0,
                    overnightMaxLeverage: 0,
                    maxLeverage: m.maxLeverage,
                    groupIndex: m.groupIndex,
                    feeIndex: m.feeIndex,
                    oracle: m.name
                })
            );
            pairIndex = ps.pairsCount() - 1;
        }

        // `_setFundingParams` reads exactly ONE field of `Config` — `c.registry` — so it is
        // reused verbatim through a zero-initialised stub rather than copied. Copying it would
        // put the division-by-zero rationale and the `setPairFundingFees` validation limits in
        // two places that must never drift; the stub keeps one implementation of both. The
        // dependency is real and the compiler cannot see it: were `_setFundingParams` ever to
        // read a second `Config` field it would read a zero here, so it must stay registry-only.
        Config memory stub;
        stub.registry = m.registry;
        _setFundingParams(stub, pairIndex);

        return pairIndex;
    }

    /// @notice Lifts an arbitrary pair's open-interest ceiling off zero.
    /// @dev Caller must be `registry.manager()`, exactly as for `setMaxOi` — the difference is
    ///      only that the ceiling comes from `m` instead of the `PAIR_MAX_OI` constant, so a
    ///      market can be listed with a ceiling sized to its own liquidity.
    ///
    ///      The zero default is the silent trap `setMaxOi`'s comment describes in full:
    ///      `TradingCallbacksLib.withinExposureLimits` fails, the open transaction SUCCEEDS, the
    ///      collateral is refunded minus the oracle fee, and no position and no error exist.
    ///      A second, louder consequence applies once a position does open: a zero ceiling makes
    ///      `openInterestCap` zero in `OstiumPairInfos.getOiDelta` (`:597-604`), whose final line
    ///      divides by it — `Panic(0x12)` on any path that settles funding.
    function setMaxOiFor(MarketConfig memory m, uint16 pairIndex) public {
        IOstiumTradingStorage ts =
            IOstiumTradingStorage(IOstiumRegistry(m.registry).getContractAddress("tradingStorage"));
        if (ts.openInterest(pairIndex, 2) > 0) return;
        _relay(msg.sender);
        ts.setMaxOpenInterest(pairIndex, m.maxOi);
    }

    /// @notice Points this market's own `<oracle>PriceUpkeep` registry key at the upkeep the
    ///         system is already using.
    /// @dev Caller must be `registry.gov()` (`registerContract` is `onlyGov`).
    ///
    ///      This is the step with no equivalent in `addMarket`, and the one whose absence is
    ///      invisible: a pair lists successfully with no key registered, and only the first
    ///      `openTrade` on it fails — reverting inside `OstiumRegistry.getContractAddress`
    ///      (`:118-121`), which reverts `NotFound(bytes32)` rather than returning zero.
    ///
    ///      The address is READ from the registry, never supplied. `installHardenedUpkeep`
    ///      (phase 2) states the invariant this depends on: ONE upkeep instance serves every
    ///      feed, because the two pieces of per-market state it owns — `isFeedHalted[feedId]`
    ///      and the deviation baseline `lastPrice[feedId]` — are already keyed by feed inside
    ///      the contract. So the right address for a new feed is by definition whatever the
    ///      incumbent feed resolves to, and reading it removes the only way an operator could
    ///      point a new market at a stale or wrong instance by typing an address.
    ///
    ///      Deliberately NOT implemented by calling `installHardenedUpkeep(c, feedKeys)`, which
    ///      would do the same registration: that function DEPLOYS an upkeep when no key resolves
    ///      to a hardened one, and "list a market" must never be able to deploy an oracle as a
    ///      side effect. It also needs the full `OracleConfig` — signers, threshold, guardian —
    ///      none of which listing a market has any business requiring.
    function registerUpkeepFor(MarketConfig memory m) public {
        IOstiumRegistry registry = IOstiumRegistry(m.registry);
        bytes32 key = _upkeepKey(m.name);
        (bool found,) = _lookup(registry, key);
        if (found) return;
        address incumbent = _incumbentUpkeep(registry);
        _relay(msg.sender);
        registry.registerContract(key, incumbent);
    }

    /// @dev The upkeep the live system is actually delivering prices through, read from the
    ///      anchor market's key. Not `_requireHardenedUpkeep`, which additionally probes for
    ///      `maxAge()`: this path must keep working on a system that has not been migrated to
    ///      the hardened oracle yet, and in that case the correct answer for a new feed is still
    ///      "the same instance BTC/USD uses". Requiring hardening here would refuse to list a
    ///      market on a system that trades perfectly well.
    function _incumbentUpkeep(IOstiumRegistry registry) internal view returns (address) {
        (bool found, address current) = _lookup(registry, PRICE_UPKEEP_KEY);
        require(found && current != address(0), "no incumbent upkeep to reuse: run() or runOracle() first");
        return current;
    }

    /// @notice Lists every market named in `MARKETS`, each fully configured and each skipped if
    ///         already present. Invoked with `forge script ... --sig "runAddMarkets()"`.
    /// @dev A separate entrypoint for the same reason `runOracle()` and `runLiquidation()` are:
    ///      `run()`'s env block is a recorded procedure that has been executed against 1874, and
    ///      adding a required variable to it would silently invalidate that record.
    ///
    ///      Needs two keys and one address. `LP_PRIVATE_KEY`, `LP_AMOUNT`, `USDW_ADDRESS`,
    ///      `VAULT_ADDRESS`, `SIGNER_ADDRESS` and the rest of `Config` are all absent on
    ///      purpose: none of them is per-market, and demanding them would make listing a market
    ///      require the LP's key.
    ///
    ///      `MARKETS` is a comma-separated list of market names, e.g. `MARKETS=ETH/USD,SOL/USD`,
    ///      each written exactly as it appears in `packages/shared/src/markets.mjs`. It has NO
    ///      default, unlike `ORACLE_FEEDS`: a default would let an unset variable list a market
    ///      nobody asked for, and there is no unlisting — `removePair`
    ///      (`OstiumPairsStorage.sol:188-199`) requires zero traders and still never frees the
    ///      index. Replay is safe: every step below returns early when its work is already done.
    ///
    ///      The four optional variables apply to EVERY market in one run. Markets needing
    ///      different ceilings should be listed in separate runs rather than by adding a
    ///      per-market encoding to an env string.
    function runAddMarkets() external {
        require(block.chainid == 1874, "unsupported chain");
        _broadcasting = true;

        string[] memory names = vm.envString("MARKETS", ",");
        address registry = vm.envAddress("REGISTRY_ADDRESS");
        uint32 maxLeverage = uint32(vm.envOr("MARKET_MAX_LEVERAGE", uint256(PAIR_MAX_LEVERAGE)));
        uint256 maxOi = vm.envOr("MARKET_MAX_OI", PAIR_MAX_OI);
        uint8 groupIndex = uint8(vm.envOr("MARKET_GROUP_INDEX", uint256(0)));
        uint8 feeIndex = uint8(vm.envOr("MARKET_FEE_INDEX", uint256(0)));

        uint256 govKey = vm.envUint("GOV_PRIVATE_KEY");
        uint256 managerKey = vm.envUint("MANAGER_PRIVATE_KEY");

        for (uint256 i = 0; i < names.length; i++) {
            MarketConfig memory m = MarketConfig({
                registry: registry,
                name: names[i],
                maxLeverage: maxLeverage,
                maxOi: maxOi,
                groupIndex: groupIndex,
                feeIndex: feeIndex
            });

            vm.startBroadcast(govKey);
            registerUpkeepFor(m);
            vm.stopBroadcast();

            vm.startBroadcast(govKey);
            uint16 pairIndex = addMarketFor(m);
            vm.stopBroadcast();

            vm.startBroadcast(managerKey);
            setMaxOiFor(m, pairIndex);
            vm.stopBroadcast();
        }
    }
}
