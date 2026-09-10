import { query, queryOne } from '../db.js';
import { price, collateral, leverage as fmtLeverage } from '../format.js';
import { INTERVALS } from '@whitespace/shared/candles';
import { readIndexCandles } from '../indexSeries.js';
import type { RouteResult, Handler } from '../router.js';

type MarketRow = {
  pair_index: number;
  from_symbol: string;
  to_symbol: string;
  feed_id: string;
  max_leverage: number;
  max_open_interest: string;
  open_interest_long: string;
  open_interest_short: string;
};

function shapeMarket(row: MarketRow) {
  return {
    pairIndex: row.pair_index,
    from: row.from_symbol,
    to: row.to_symbol,
    feedId: row.feed_id,
    maxLeverage: fmtLeverage(row.max_leverage),
    maxOpenInterest: collateral(row.max_open_interest),
    openInterest: {
      long: collateral(row.open_interest_long),
      short: collateral(row.open_interest_short),
    },
  };
}

export async function handleMarkets(): Promise<RouteResult> {
  const rows = await query<MarketRow>('SELECT * FROM market ORDER BY pair_index');
  return { code: 200, body: rows.map(shapeMarket) };
}

export const handleMarket: Handler = async (_req, params) => {
  const pairIndex = Number(params.pairIndex);
  if (!Number.isInteger(pairIndex)) {
    return { code: 400, body: { error: 'invalid pairIndex' } };
  }
  const row = await queryOne<MarketRow>('SELECT * FROM market WHERE pair_index = $1', [pairIndex]);
  if (!row) {
    return { code: 404, body: { error: 'market not found' } };
  }
  return { code: 200, body: shapeMarket(row) };
};

type CandleRow = {
  bucket_start: number;
  open: string;
  high: string;
  low: string;
  close: string;
  volume: string;
};

const DEFAULT_CANDLE_LIMIT = 500;

export const handleCandles: Handler = async (_req, params, searchParams) => {
  const pairIndex = Number(params.pairIndex);
  if (!Number.isInteger(pairIndex)) {
    return { code: 400, body: { error: 'invalid pairIndex' } };
  }

  const interval = searchParams.get('interval') ?? '1h';
  if (!(INTERVALS as readonly string[]).includes(interval)) {
    return { code: 400, body: { error: `invalid interval, must be one of: ${INTERVALS.join(', ')}` } };
  }

  const fromParam = searchParams.get('from');
  const toParam = searchParams.get('to');
  const from = fromParam !== null ? Number(fromParam) : 0;
  const to = toParam !== null ? Number(toParam) : Math.floor(Date.now() / 1000);
  if (!Number.isFinite(from) || !Number.isFinite(to)) {
    return { code: 400, body: { error: 'from/to must be unix seconds (integers)' } };
  }

  // The index series first — it is sampled continuously from the publisher, so it is the
  // only source that has a candle in a bucket where nobody happened to trade. See
  // src/indexSeries.ts for why the on-chain candle table alone cannot draw a chart.
  //
  // The fallback is not dead code: on a database that has never run the recorder (a fresh
  // clone, or the API started while the publisher was down) the on-chain series is all
  // there is, and a sparse chart beats an empty one.
  let rows: CandleRow[] = await readIndexCandles(pairIndex, interval, from, to);

  if (rows.length === 0) {
    if (fromParam !== null || toParam !== null) {
      rows = await query<CandleRow>(
        'SELECT bucket_start, open, high, low, close, volume FROM candle WHERE pair_index = $1 AND interval = $2 AND bucket_start >= $3 AND bucket_start <= $4 ORDER BY bucket_start ASC',
        [pairIndex, interval, from, to],
      );
    } else {
      rows = await query<CandleRow>(
        'SELECT bucket_start, open, high, low, close, volume FROM candle WHERE pair_index = $1 AND interval = $2 ORDER BY bucket_start DESC LIMIT $3',
        [pairIndex, interval, DEFAULT_CANDLE_LIMIT],
      );
      rows.reverse();
    }
  }

  return {
    code: 200,
    body: rows.map((r) => ({
      t: r.bucket_start,
      o: price(r.open),
      h: price(r.high),
      l: price(r.low),
      c: price(r.close),
      v: collateral(r.volume),
    })),
  };
};
