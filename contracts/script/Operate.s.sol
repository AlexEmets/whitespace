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
    ///      same mechanism `Deploy.s.sol`'s `deployAll()` relies on). But `vm.prank` cannot be
    ///      called at all while a broadcast is active — it reverts unconditionally with
    ///      "cannot `prank` for a broadcasted transaction", confirmed empirically — so the
    ///      relay wraps its `vm.prank` in try/catch: it succeeds and does real work under
    ///      `vm.prank`-driven tests, and harmlessly no-ops under `vm.startBroadcast`-driven runs.
    function _relay(address who) internal {
        try vm.prank(who) {} catch {}
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
    function mintToLp(Config memory c) public {
        USDW usdw = USDW(c.usdw);
        if (usdw.balanceOf(c.lp) >= c.lpAmount) return;
        _relay(msg.sender);
        usdw.mint(c.lp, c.lpAmount);
    }

    /// @notice Requests an LP deposit of `c.lpAmount` into the vault.
    /// @dev Caller must be `c.lp`. The approve target is the vault itself, because
    ///      `OstiumVault.requestDeposit` executes `safeTransferFrom` from inside its own code,
    ///      making the vault the ERC-20 `msg.sender` for that transfer. Skipped, returning 0,
    ///      once `currentBalance() > 0` — the post-settlement signal that liquidity landed.
    function requestLpDeposit(Config memory c) public returns (uint32 settlementId) {
        IOstiumVault vault = IOstiumVault(c.vault);
        if (vault.currentBalance() > 0) return 0;

        settlementId = vault.targetSettlementId(true);

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
    /// @dev Caller must be `c.lp`. Skipped if there is no pending settlement to claim
    ///      (`settlementId == 0`) or if the deposit is already reflected in the vault's balance.
    function claimLpDeposit(Config memory c, uint32 settlementId) public {
        IOstiumVault vault = IOstiumVault(c.vault);
        if (settlementId == 0 || vault.currentBalance() > 0) return;
        _relay(msg.sender);
        vault.claimDeposit(settlementId);
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
    function run() external {
        require(block.chainid == 1874, "unsupported chain");

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
