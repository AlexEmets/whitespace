/**
 * Automation candidates, read straight from the indexer's Postgres every sweep (design
 * spec §4, §9.3): open trades from `position`, resting LIMIT/STOP entries from
 * `limit_order`. Nothing is kept between sweeps, so a restart sees every position and
 * order at once — there is no in-memory table built from "events since I started".
 *
 * The rows only say WHICH slots to look at. Every decision re-reads the slot from chain
 * first (automationEngine.mjs), so an indexer that lags or is briefly wrong can cost a
 * wasted read, never a wrong trigger.
 *
 * Column names are Ponder's snake_case of services/indexer/ponder.schema.ts (`position`)
 * and of the `limit_order` contract in the design spec §9.1. node-postgres returns
 * NUMERIC as a string and INTEGER as a number; both go through BigInt(String(v)).
 */

const SCHEMA_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const UNDEFINED_TABLE = '42P01';

const big = (v) => BigInt(String(v));

/**
 * @param {object} opts
 * @param {(text: string, params?: unknown[]) => Promise<Record<string, unknown>[]>} opts.query
 * @param {string} [opts.schema] Postgres schema the indexer writes to (DATABASE_SCHEMA)
 */
export function createCandidateSource({ query, schema = 'public' }) {
  if (!SCHEMA_NAME.test(schema)) throw new Error(`createCandidateSource: invalid schema name ${JSON.stringify(schema)}`);
  const q = (table) => `"${schema}"."${table}"`;

  async function listPositions() {
    const rows = await query(
      `SELECT trade_id, trader, pair_index, "index", buy, collateral, leverage, open_price, tp, sl, is_day_trade
         FROM ${q('position')}
        ORDER BY pair_index, trader, "index"`,
    );
    return rows.map((r) => ({
      tradeId: big(r.trade_id),
      trader: String(r.trader).toLowerCase(),
      pairIndex: Number(r.pair_index),
      index: Number(r.index),
      buy: Boolean(r.buy),
      collateral: big(r.collateral),
      leverage: big(r.leverage),
      openPrice: big(r.open_price),
      tp: big(r.tp),
      sl: big(r.sl),
      isDayTrade: Boolean(r.is_day_trade),
    }));
  }

  /**
   * `limit_order` is being added to the indexer alongside this bot. Until that indexer
   * version is deployed the table does not exist; that is reported (so it shows on logs
   * and metrics) rather than failing every sweep and starving liquidations.
   */
  async function listLimitOrders() {
    try {
      const rows = await query(
        `SELECT trader, pair_index, "index", order_type, buy, collateral, leverage, trigger_price, tp, sl, updated_at
           FROM ${q('limit_order')}
          ORDER BY pair_index, trader, "index"`,
      );
      return {
        available: true,
        orders: rows.map((r) => ({
          trader: String(r.trader).toLowerCase(),
          pairIndex: Number(r.pair_index),
          index: Number(r.index),
          orderType: String(r.order_type),
          buy: Boolean(r.buy),
          collateral: big(r.collateral),
          leverage: big(r.leverage),
          targetPrice: big(r.trigger_price),
          tp: big(r.tp),
          sl: big(r.sl),
          updatedAt: Number(r.updated_at),
        })),
      };
    } catch (err) {
      if (err?.code === UNDEFINED_TABLE) return { available: false, orders: [] };
      throw err;
    }
  }

  async function list() {
    const [positions, limit] = await Promise.all([listPositions(), listLimitOrders()]);
    return { positions, limitOrders: limit.orders, limitOrdersAvailable: limit.available };
  }

  return { list, listPositions, listLimitOrders };
}

/**
 * node-postgres adapter. The pool is created lazily by the caller (main.mjs) so tests
 * never need a database driver.
 * @param {{ query: (text: string, params?: unknown[]) => Promise<{ rows: any[] }> }} pool
 */
export function pgQuery(pool) {
  return async (text, params = []) => (await pool.query(text, params)).rows;
}
