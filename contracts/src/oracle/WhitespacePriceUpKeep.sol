// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";

import {IOstiumRegistry} from "../vendor/ostium/interfaces/IOstiumRegistry.sol";
import {IOstiumVerifier} from "../vendor/ostium/interfaces/IOstiumVerifier.sol";
import {IOstiumPriceUpKeep} from "../vendor/ostium/interfaces/IOstiumPriceUpKeep.sol";
import {IOstiumForwarded} from "../vendor/ostium/interfaces/IOstiumForwarded.sol";
import {IOstiumPairsStorage} from "../vendor/ostium/interfaces/IOstiumPairsStorage.sol";
import {IOstiumTradingCallbacks} from "../vendor/ostium/interfaces/IOstiumTradingCallbacks.sol";
import {IOwnable} from "../vendor/ostium/interfaces/IOwnable.sol";

/// @title  WhitespacePriceUpKeep — price delivery with contract-side rails
/// @notice Drop-in replacement for the vendored `OstiumPrivatePriceUpKeep` under the per-oracle
///         registry key (`"<pair.oracle>PriceUpkeep"`, e.g. `"BTC/USDPriceUpkeep"`). Implements
///         `IOstiumPriceUpKeep` + `IOstiumForwarded`, so `OstiumPriceRouter`,
///         `OstiumTradingCallbacks` and `Operate.s.sol` all keep working unchanged.
///
/// @dev    **Layer 2 of the two-layer oracle defence** (design spec §6.3). Everything the
///         vendored upkeep does is preserved verbatim — the `onlyRouter` request, the
///         `PriceRequestedV2` event, the forwarder gate on `performUpkeep`, the byte-identical
///         `order.timestamp` check, and the `fulfill` dispatch into `IOstiumTradingCallbacks`.
///         What is added are four rails that hold **even when every signer is honest and the
///         k-of-N threshold is fully satisfied**:
///
///         | Rail | Failure it catches |
///         |---|---|
///         | `maxAge` (10 s) | frozen or replayed feed |
///         | `maxDeviationBps` (500 bps) vs last accepted price | aggregation bug producing a jump |
///         | Per-feed circuit breaker | incident on one asset |
///         | Global pause (guardian, immediate) | everything else |
///
///         These are a **backstop, not the tuned filter**. The publisher's own bounds (2 s venue
///         staleness, 50 bps venue deviation, 3-of-4 healthy venues) are an order of magnitude
///         tighter. A rail that trips in normal operation is a liveness bug, not a safety
///         feature — hence the deliberately loose defaults.
///
/// ### Deployment shape
///
/// Plain constructor, deployed directly — no `Initializable`, no `ERC1967Proxy`, unlike
/// `Deploy.s.sol`'s treatment of the vendored upkeep. That proxy is not an upgrade path:
/// **no contract in `src/vendor/` inherits `UUPSUpgradeable` or exposes `upgradeToAndCall`**
/// (verified by grep over the whole vendored tree), so an `ERC1967Proxy` in front of an
/// `Initializable`-only implementation can never actually be upgraded. It buys a second
/// deployment, an extra `DELEGATECALL` on every price delivery, and an uninitialised-
/// implementation footgun, in exchange for nothing.
///
/// ### Wire format
///
/// The verified payload is the nine-field report described on `WhitespaceVerifier`. The first
/// two fields (`chainId`, `verifier`) are consumed by the verifier for domain separation and
/// deliberately ignored here — re-checking them would be duplicated trust, not defence in
/// depth. Prices carry **exactly 18 decimals**; a wrong exponent reverts nowhere, it opens the
/// position at the wrong price. The deviation rail is the only thing in the system that would
/// notice, and only for feeds that already have a baseline.
contract WhitespacePriceUpKeep is IOstiumPriceUpKeep, IOstiumForwarded {
    using SafeCast for uint256;

    uint256 private constant BPS_DENOMINATOR = 10_000;

    /// @dev Spec §5.2 initial values. Baked in as constructor defaults so a deployment that
    ///      forgets to configure is safe rather than open; gov tunes them afterwards.
    uint32 public constant DEFAULT_MAX_AGE = 10; // seconds
    uint16 public constant DEFAULT_MAX_DEVIATION_BPS = 500; // 5.00%

    IOstiumRegistry public immutable registry;

    mapping(uint256 orderId => Order) public orders;
    mapping(address => bool) public isForwarder;

    /// @notice May pause the whole upkeep and halt individual feeds, immediately and with no
    ///         timelock. Cannot un-pause, un-halt, or change any parameter — that is gov only.
    /// @dev The asymmetry is the point: the emergency stop must be reachable by a hot key on a
    ///      pager rotation, while restarting the exchange must not be.
    address public guardian;

    bool public paused;
    uint32 public maxAge;
    uint16 public maxDeviationBps;

    mapping(bytes32 feedId => bool) public isFeedHalted;

    /// @notice Last price accepted for a feed, 18 decimals. Zero means "no baseline yet".
    /// @dev Zero is an unambiguous sentinel because `_checkPrice` rejects any non-positive
    ///      price on an open market, so a real accepted price is always strictly positive.
    mapping(bytes32 feedId => int192) public lastPrice;

    event GuardianUpdated(address guardian);
    event PauseUpdated(bool paused);
    event FeedHaltUpdated(bytes32 indexed feedId, bool halted);
    event MaxAgeUpdated(uint32 maxAge);
    event MaxDeviationBpsUpdated(uint16 maxDeviationBps);
    event PriceBaselineCleared(bytes32 indexed feedId, int192 previousPrice);
    event PriceAccepted(bytes32 indexed feedId, int192 price, uint32 timestamp);

    error IsPaused();
    error NotGuardianOrGov(address a);
    error FeedHalted(bytes32 feedId);
    error StaleReport(uint32 reportTimestamp, uint256 blockTimestamp, uint32 maxAge);
    error PriceDeviationTooLarge(bytes32 feedId, int192 previousPrice, int192 newPrice, uint16 maxDeviationBps);
    error NonPositivePrice(bytes32 feedId, int192 price);

    modifier onlyGov() {
        _onlyGov();
        _;
    }

    function _onlyGov() private view {
        if (msg.sender != registry.gov()) revert NotGov(msg.sender);
    }

    modifier onlyGuardianOrGov() {
        if (msg.sender != guardian && msg.sender != registry.gov()) {
            revert NotGuardianOrGov(msg.sender);
        }
        _;
    }

    modifier onlyTimelock() {
        _onlyTimelock();
        _;
    }

    function _onlyTimelock() private view {
        if (msg.sender != IOwnable(address(registry)).owner()) revert NotTimelock(msg.sender);
    }

    modifier onlyRouter() {
        _onlyRouter();
        _;
    }

    function _onlyRouter() private view {
        if (msg.sender != registry.getContractAddress("priceRouter")) revert NotRouter(msg.sender);
    }

    constructor(IOstiumRegistry _registry, address _guardian) {
        if (address(_registry) == address(0) || _guardian == address(0)) revert WrongParams();
        registry = _registry;
        guardian = _guardian;
        maxAge = DEFAULT_MAX_AGE;
        maxDeviationBps = DEFAULT_MAX_DEVIATION_BPS;
        emit GuardianUpdated(_guardian);
        emit MaxAgeUpdated(DEFAULT_MAX_AGE);
        emit MaxDeviationBpsUpdated(DEFAULT_MAX_DEVIATION_BPS);
    }

    // ---------------------------------------------------------------------------------------
    // Phase 1 — the router records a price request
    // ---------------------------------------------------------------------------------------

    /// @notice Record a pending price request. Mirrors the vendored upkeep exactly, except that
    ///         a paused upkeep or a halted feed rejects the request outright.
    /// @dev Rejecting at REQUEST time as well as at delivery time is deliberate. A pause that
    ///      only blocked delivery would let `openTrade` succeed, take the trader's collateral
    ///      into `tradingStorage`, and then strand it for `marketOrdersTimeout` blocks until the
    ///      trader remembers to call the timeout reclaim. Reverting here means the whole
    ///      `openTrade`/`closeTradeMarket` transaction reverts and no collateral moves at all.
    ///
    ///      It does also stop closes and liquidations while paused. That is the intended
    ///      behaviour of an emergency stop: when the price source is not trusted, closing a
    ///      position at an untrusted price is not obviously better than not closing it.
    function getPrice(uint256 orderId, uint16 pairIndex, OrderType orderType, uint256 timestamp)
        external
        onlyRouter
    {
        if (paused) revert IsPaused();
        if (orders[orderId].initiated) revert AlreadyInitiated(orderId);

        bytes32 feed = IOstiumPairsStorage(registry.getContractAddress("pairsStorage")).pairFeed(pairIndex);
        if (isFeedHalted[feed]) revert FeedHalted(feed);

        orders[orderId] = Order(timestamp.toUint32(), pairIndex, orderType, true, feed);

        emit PriceRequestedV2(orderId, orderType, feed, timestamp);
    }

    // ---------------------------------------------------------------------------------------
    // Phase 2 — the forwarder delivers a signed report
    // ---------------------------------------------------------------------------------------

    /// @notice Verify and apply a threshold-signed price report to a pending order.
    /// @param  performData `abi.encode(bytes signedReport, uint256 orderId)`.
    function performUpkeep(bytes calldata performData) external {
        if (!isForwarder[msg.sender]) revert NotForwarder(msg.sender);
        if (paused) revert IsPaused();

        (bytes memory report, uint256 orderId) = abi.decode(performData, (bytes, uint256));

        Order memory order = orders[orderId];
        if (!order.initiated) revert NotInitiated(orderId);

        // Backward compatibility with the vendored upkeep: orders written before `feedId` was
        // added to `Order` carry a zero feed and must be resolved from storage.
        bytes32 expectedFeedId = order.feedId;
        if (expectedFeedId == bytes32(0)) {
            expectedFeedId =
                IOstiumPairsStorage(registry.getContractAddress("pairsStorage")).pairFeed(order.pairIndex);
        }
        if (isFeedHalted[expectedFeedId]) revert FeedHalted(expectedFeedId);

        bytes memory verifierResponse =
            IOstiumVerifier(registry.getContractAddress("ostiumVerifier")).verify(report);

        bytes32 reportFeedId;
        uint32 timestamp;
        bool isMarketOpen;

        PriceUpKeepAnswer memory a;
        a.orderId = orderId;

        // Fields 1-2 (chainId, verifier) were checked by the verifier; skipping them here is
        // not a gap, it is the layer boundary.
        (,, reportFeedId, timestamp, a.price, a.bid, a.ask, isMarketOpen, a.isDayTradingClosed) = abi.decode(
            verifierResponse, (uint256, address, bytes32, uint32, int192, int192, int192, bool, bool)
        );

        // THE two-phase guarantee: the report's timestamp must be byte-identical to the one
        // recorded when the order was requested, which forces the price to have been signed
        // AFTER the trader committed. Without it, a trader could execute against a price
        // observed before they decided to trade — the GMX v1 stale-price exploit class.
        if (order.timestamp != timestamp || expectedFeedId != reportFeedId) {
            revert InvalidPrice(orderId);
        }

        // Rail 1 — staleness. Bounds how long a signed report stays usable. Because the report
        // timestamp is pinned to the order timestamp above, on this contract it doubles as a
        // ceiling on keeper delivery latency: deliver within `maxAge` seconds of the request.
        if (block.timestamp > uint256(timestamp) + maxAge) {
            revert StaleReport(timestamp, block.timestamp, maxAge);
        }

        if (isMarketOpen) {
            // Rail 2 — deviation from this feed's last accepted price.
            _checkPrice(expectedFeedId, a.price);
            lastPrice[expectedFeedId] = a.price;
            emit PriceAccepted(expectedFeedId, a.price, timestamp);
        } else {
            // Same as the vendored upkeep: a closed market carries no tradeable price, and the
            // callbacks treat a zero price as MARKET_CLOSED. No baseline update, and the
            // deviation rail is skipped — checking a deliberately zeroed price against a live
            // baseline would trip on every closed-market report.
            delete a.price;
            delete a.bid;
            delete a.ask;
        }

        fulfill(a);

        emit PriceReceived(orderId, order.pairIndex, a.price, 0);
    }

    /// @dev Rail 2. The first accepted price for a feed sets the baseline and is NOT
    ///      deviation-checked — there is nothing to compare it against, and inventing a bound
    ///      would mean hardcoding an expected price per asset.
    ///
    ///      Non-positive prices are rejected outright on an open market. That is not decoration:
    ///      it is what makes `lastPrice == 0` a sound "no baseline" sentinel, and a zero price
    ///      that reached the callbacks would be read as MARKET_CLOSED rather than as an error.
    ///
    ///      Overflow: `diff` and `previous` are bounded by `int192`, so the widened products are
    ///      at most ~2^208 — far inside `uint256`.
    function _checkPrice(bytes32 feedId, int192 price) private view {
        if (price <= 0) revert NonPositivePrice(feedId, price);

        int192 previous = lastPrice[feedId];
        if (previous == 0) return; // first accepted price for this feed: baseline only

        uint256 previousAbs = uint256(uint192(previous));
        uint256 diff =
            price > previous ? uint256(uint192(price - previous)) : uint256(uint192(previous - price));

        if (diff * BPS_DENOMINATOR > previousAbs * maxDeviationBps) {
            revert PriceDeviationTooLarge(feedId, previous, price, maxDeviationBps);
        }
    }

    /// @dev Byte-identical dispatch to the vendored upkeep.
    function fulfill(PriceUpKeepAnswer memory a) internal {
        Order memory r = orders[a.orderId];

        IOstiumTradingCallbacks c = IOstiumTradingCallbacks(registry.getContractAddress("callbacks"));

        if (r.orderType == OrderType.MARKET_OPEN) {
            c.openTradeMarketCallback(a);
        } else if (r.orderType == OrderType.MARKET_CLOSE) {
            c.closeTradeMarketCallback(a);
        } else if (r.orderType == OrderType.LIMIT_OPEN) {
            c.executeAutomationOpenOrderCallback(a);
        } else if (r.orderType == OrderType.LIMIT_CLOSE) {
            c.executeAutomationCloseOrderCallback(a);
        } else if (r.orderType == OrderType.REMOVE_COLLATERAL) {
            c.handleRemoveCollateral(a);
        }
        delete orders[a.orderId];
    }

    // ---------------------------------------------------------------------------------------
    // Rails 3 and 4 — circuit breaker and global pause
    // ---------------------------------------------------------------------------------------

    /// @notice Halt one feed without touching any other. Guardian or gov, immediate.
    function haltFeed(bytes32 feedId) external onlyGuardianOrGov {
        isFeedHalted[feedId] = true;
        emit FeedHaltUpdated(feedId, true);
    }

    /// @notice Resume one halted feed. Gov only — the guardian stops, gov restarts.
    function resumeFeed(bytes32 feedId) external onlyGov {
        isFeedHalted[feedId] = false;
        emit FeedHaltUpdated(feedId, false);
    }

    /// @notice Halt every feed at once. Guardian or gov, immediate, no timelock.
    function pause() external onlyGuardianOrGov {
        paused = true;
        emit PauseUpdated(true);
    }

    /// @notice Resume the upkeep. Gov only.
    function unpause() external onlyGov {
        paused = false;
        emit PauseUpdated(false);
    }

    // ---------------------------------------------------------------------------------------
    // Parameters — gov only
    // ---------------------------------------------------------------------------------------

    function setGuardian(address newGuardian) external onlyGov {
        if (newGuardian == address(0)) revert WrongParams();
        guardian = newGuardian;
        emit GuardianUpdated(newGuardian);
    }

    /// @dev Zero is refused: it would reject every report whose block is even one second past
    ///      the request, i.e. all of them.
    function setMaxAge(uint32 newMaxAge) external onlyGov {
        if (newMaxAge == 0) revert WrongParams();
        maxAge = newMaxAge;
        emit MaxAgeUpdated(newMaxAge);
    }

    /// @dev Zero is refused for the same reason: it would pin every feed to its baseline
    ///      forever. The upper bound is `BPS_DENOMINATOR` (100%), above which the rail cannot
    ///      reject anything upward and is therefore off in one direction only — a confusing
    ///      half-disabled state, better expressed by halting the feed.
    function setMaxDeviationBps(uint16 newMaxDeviationBps) external onlyGov {
        if (newMaxDeviationBps == 0 || newMaxDeviationBps > BPS_DENOMINATOR) revert WrongParams();
        maxDeviationBps = newMaxDeviationBps;
        emit MaxDeviationBpsUpdated(newMaxDeviationBps);
    }

    /// @notice Drop a feed's deviation baseline so the next accepted price re-establishes it.
    /// @dev Required for liveness, not convenience. A genuine market move larger than
    ///      `maxDeviationBps` — a crash, a weekend gap, a market that reopens far from where it
    ///      closed — makes every subsequent honest report deviate from a baseline that is now
    ///      stale, and the feed is wedged permanently with no way back. This is the way back,
    ///      and it is gov-only because it is also the way to disarm rail 2 for one report.
    function clearPriceBaseline(bytes32 feedId) external onlyGov {
        int192 previous = lastPrice[feedId];
        delete lastPrice[feedId];
        emit PriceBaselineCleared(feedId, previous);
    }

    // ---------------------------------------------------------------------------------------
    // Forwarders — identical roles to the vendored upkeep (register: timelock, remove: gov)
    // ---------------------------------------------------------------------------------------

    function registerForwarder(address forwarderAddress) public onlyTimelock {
        if (isForwarder[forwarderAddress]) revert AlreadyForwarder(forwarderAddress);
        isForwarder[forwarderAddress] = true;
        emit ForwarderAdded(forwarderAddress);
    }

    function registerForwarders(address[] calldata forwarderAddresses) external onlyTimelock {
        for (uint256 i = 0; i < forwarderAddresses.length; i++) {
            registerForwarder(forwarderAddresses[i]);
        }
    }

    function unregisterForwarder(address forwarderAddress) public onlyGov {
        if (!isForwarder[forwarderAddress]) revert NotForwarder(forwarderAddress);
        delete isForwarder[forwarderAddress];
        emit ForwarderRemoved(forwarderAddress);
    }

    function unregisterForwarders(address[] calldata forwarderAddresses) external onlyGov {
        for (uint256 i = 0; i < forwarderAddresses.length; i++) {
            unregisterForwarder(forwarderAddresses[i]);
        }
    }
}
