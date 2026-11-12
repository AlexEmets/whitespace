# @whitespace/shared

Constants and pure helpers that more than one service has to agree on: chains, markets,
venues, price-pipeline bounds, exact decimal math, candles, points scoring, the order-type
enum, role key loading and the public API catalogue. Plain ESM `.mjs` source with no build
step and no dependencies; the modules that the web app imports from TypeScript ship a
hand-written `.d.ts` next to them.

Import by subpath:

```js
import { getMarket, getMarketByFeedId } from '@whitespace/shared/markets';
import { boundsForMarket } from '@whitespace/shared/bounds';
import { parseDecimalTo18, formatFixed18 } from '@whitespace/shared/decimal';

const btc = getMarket('BTC/USD');          // { feed, feedId: bytes32 hex, venueSymbols }
const bounds = boundsForMarket('WBT/USD'); // PUBLISHER_BOUNDS with the WBT override merged in
formatFixed18(parseDecimalTo18('65001.23000000')); // "65001.23"
```

## Modules

| Subpath | Exports | What it is |
|---|---|---|
| `.` / `./chains` | `CHAINS` | Whitechain 1874, 2625 and 1875: name, RPC and the capabilities each is expected to have (`eip1559`, `cancun`, `create2Factory`, `multicall3`). |
| `./markets` | `MARKETS`, `MARKET_FEEDS`, `getMarket`, `getMarketByFeedId`, `asciiToBytes32Hex` | The market registry: feed name, on-chain `bytes32` feed id and each venue's symbol. BTC, ETH, SOL and XRP are quoted on Binance, Bybit, OKX and WhiteBIT; WBT on WhiteBIT's spot and perp books. `getMarket` throws on an unknown feed; `getMarketByFeedId` returns `undefined`. |
| `./venues` | `VENUE_IDS`, `VENUES`, `weightOf` | The canonical venue ids and their weight in the weighted-median index (all `1n`). |
| `./bounds` | `PUBLISHER_BOUNDS`, `MARKET_BOUNDS_OVERRIDES`, `boundsForMarket`, `CONTRACT_BOUNDS` and the named constants behind them | Price-pipeline thresholds: venue staleness (2 s), spread width (10 bps), deviation (50 bps), minimum healthy venues (3), mark EMA window and sample interval. WBT/USD overrides staleness to 8 s and the minimum to 2. `CONTRACT_BOUNDS` mirrors the on-chain limits (report max age, max deviation, 3-of-5 signatures, market order timeout) for reference only; nothing here enforces them. |
| `./decimal` | `PRICE_DECIMALS`, `PRICE_SCALE`, `SCALE`, `parseDecimalTo18`, `formatFixed18`, `bpsOf`, `deviationBps`, `toDecimalString`, `parseDecimalToBigInt` | Exact bigint fixed-point math. See below. |
| `./candles` | `INTERVAL_SECONDS`, `INTERVALS`, `bucketStart`, `applyTick` | OHLCV bucketing on integer unix seconds for `1m`, `5m`, `15m`, `1h`, `4h`, `1d`. `applyTick(existing, price, volume)` returns a new candle; all prices and volumes are bigint. |
| `./points` | `MISSIONS`, `missionPointsRaw`, `timeInMarketPointsRaw`, `streakMultiplierBps`, `streakDayAwardRaw`, `lpPointsRaw`, `creditUnderCap`, `utcDayIndex`, `seasonTotalRaw` and the caps/constants | Season One points scoring. See below. |
| `./orderTypes` | `ORDER_TYPE_NAMES`, `orderTypeName` | Mirror of the `IWhitespacePriceUpKeep.OrderType` enum. `orderTypeName` throws on an unknown value. |
| `./keys` | `loadKeyFile`, `loadKeyFiles` | Reads role key files (`~/.whitespace-keys/<role>.json` by convention, a one-element array with `address` and `private_key`) into `{ address, privateKey }`. Throws if the file is not shaped like a key file. Never logs the key. |
| `./api` | `API_GROUPS`, `API_ENDPOINTS`, `WS_CHANNELS`, `WS_LIMITS`, `publicEndpoints` | The public REST and WebSocket API, described once. `publicEndpoints()` leaves out entries marked `internal`. |

### Decimals

Prices carry 18 decimals, USDW collateral 6 and leverage 2 (`SCALE`). Money never passes
through a float. The two parsers differ on purpose:

- `parseDecimalTo18(input)` **truncates** digits past 18, because a price feed must never
  round toward a more favourable number.
- `parseDecimalToBigInt(input, decimals)` **throws** (`RangeError`) on excess digits,
  because over-precise input from an API caller is a bug to surface.

`formatFixed18` strips trailing zeros for logs; `toDecimalString(raw, decimals)` keeps
exactly `decimals` digits for a stable wire format and accepts the numeric strings
node-postgres returns. `bpsOf` and `deviationBps` return `null` for a non-positive
denominator.

### Points

Points are bigints at 6 decimals (`POINTS_DECIMALS`), like USDW. Four components:

- **Missions**: one-time per wallet, from the `MISSIONS` catalogue. `missionPointsRaw`
  throws on an unknown id rather than awarding zero.
- **Time in market**: `min(notional, 50k) * hours / 10_000`; positions held under 5
  minutes earn nothing. Daily cap `TIME_DAILY_CAP_RAW` (100 points).
- **Day streak**: 10 points per qualifying day, multiplier rising linearly from x1.0 on day
  1 to x1.5 on day 7.
- **Pool (LP)**: `usdw-days / 1000`, daily cap `LP_DAILY_CAP_RAW` (50 points).

The scoring functions do not apply the daily caps themselves; callers sum per UTC day and
cap with `creditUnderCap(accruedToday, add, cap)`.

```js
import { timeInMarketPointsRaw, creditUnderCap, TIME_DAILY_CAP_RAW } from '@whitespace/shared/points';

const earned = timeInMarketPointsRaw({ notionalRaw: 10_000_000_000n, heldSeconds: 3600 });
const credited = creditUnderCap(accruedTodayRaw, earned, TIME_DAILY_CAP_RAW);
```

## Consumers

| Consumer | Uses |
|---|---|
| `services/price-publisher` | `bounds`, `decimal`, `keys`, `markets`, `orderTypes`, `venues` |
| `services/keeper` | `bounds`, `keys`, `markets`, `orderTypes` |
| `services/liquidator` | `bounds`, `decimal`, `keys`, `markets` |
| `services/indexer` | `candles`, `points` |
| `services/api` | `candles`, `decimal`, `keys`, `points`; its tests check `api` against the registered routes |
| `apps/web` | `api`, `bounds`, `candles`, `chains`, `decimal`, `markets`, `points` (listed in `transpilePackages`) |
| `tools/` | `chain-probe` reads `chains`, `oracle-probe` reads `keys`, `stack/shifted-publisher.mjs` loads it through the publisher |

The indexer and the web app share `points` so the live counter on a page and the stored
total use the same rules.

## Tests

```bash
pnpm --filter @whitespace/shared test   # node --test
```
