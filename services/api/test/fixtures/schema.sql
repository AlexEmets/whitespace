-- Test-only mirror of the tables Ponder creates from
-- services/indexer/ponder.schema.ts.
--
-- Provenance: this is NOT hand-typed. It was captured with
--   pg_dump --schema-only -t market -t price_request -t price_report \
--     -t '"order"' -t position -t closed_position -t lp_activity \
--     -t candle -t sync_status
-- against a Postgres database that `ponder start` had just synced live
-- against Whitechain testnet 1874 (see docs/decisions/phase-4-indexer-api.md
-- for the exact session). It intentionally omits Ponder's internal
-- bookkeeping objects (_ponder_meta, _ponder_checkpoint, the _reorg__*
-- shadow tables, the live_query() trigger/function, the operation_id
-- sequence) — the API only ever reads the "live" tables below, never the
-- reorg-internal ones, so those are out of scope for these tests.
--
-- This file is a manually-maintained mirror, not generated at test time —
-- if ponder.schema.ts changes, this file must be regenerated the same way
-- (a fresh `ponder start` against a scratch Postgres, then the same
-- pg_dump command) and NOT hand-edited from memory. See the report's
-- "what was not verified" section for the risk this carries.

CREATE TABLE market (
    pair_index integer NOT NULL,
    from_symbol text NOT NULL,
    to_symbol text NOT NULL,
    feed_id text NOT NULL,
    oracle text NOT NULL,
    group_index integer NOT NULL,
    fee_index integer NOT NULL,
    max_leverage integer NOT NULL,
    max_open_interest numeric(78,0) NOT NULL,
    open_interest_long numeric(78,0) NOT NULL,
    open_interest_short numeric(78,0) NOT NULL,
    updated_at_block numeric(78,0) NOT NULL,
    updated_at integer NOT NULL,
    PRIMARY KEY (pair_index)
);

CREATE TABLE price_request (
    order_id numeric(78,0) NOT NULL,
    pair_index integer,
    order_type integer NOT NULL,
    feed_id text NOT NULL,
    requested_at integer NOT NULL,
    block_number numeric(78,0) NOT NULL,
    tx_hash text NOT NULL,
    PRIMARY KEY (order_id)
);

CREATE TABLE price_report (
    order_id numeric(78,0) NOT NULL,
    pair_index integer NOT NULL,
    price numeric(78,0) NOT NULL,
    native_fee numeric(78,0) NOT NULL,
    block_number numeric(78,0) NOT NULL,
    block_timestamp integer NOT NULL,
    tx_hash text NOT NULL,
    PRIMARY KEY (order_id)
);

CREATE TABLE "order" (
    order_id numeric(78,0) NOT NULL,
    trader text NOT NULL,
    pair_index integer NOT NULL,
    kind text NOT NULL,
    trade_id numeric(78,0),
    index integer,
    buy boolean,
    collateral numeric(78,0),
    leverage integer,
    status text NOT NULL,
    requested_at integer NOT NULL,
    requested_at_block numeric(78,0) NOT NULL,
    request_tx_hash text NOT NULL,
    resolved_at integer,
    resolved_tx_hash text,
    cancel_reason text,
    PRIMARY KEY (order_id)
);

CREATE TABLE "position" (
    trade_id numeric(78,0) NOT NULL,
    trader text NOT NULL,
    pair_index integer NOT NULL,
    index integer NOT NULL,
    buy boolean NOT NULL,
    collateral numeric(78,0) NOT NULL,
    leverage integer NOT NULL,
    open_price numeric(78,0) NOT NULL,
    tp numeric(78,0) NOT NULL,
    sl numeric(78,0) NOT NULL,
    is_day_trade boolean NOT NULL,
    open_order_id numeric(78,0) NOT NULL,
    open_tx_hash text NOT NULL,
    opened_at integer NOT NULL,
    opened_at_block numeric(78,0) NOT NULL,
    PRIMARY KEY (trade_id)
);

CREATE TABLE closed_position (
    trade_id numeric(78,0) NOT NULL,
    trader text NOT NULL,
    pair_index integer NOT NULL,
    index integer NOT NULL,
    buy boolean NOT NULL,
    collateral numeric(78,0) NOT NULL,
    leverage integer NOT NULL,
    open_price numeric(78,0) NOT NULL,
    close_price numeric(78,0) NOT NULL,
    tp numeric(78,0) NOT NULL,
    sl numeric(78,0) NOT NULL,
    close_reason text NOT NULL,
    percent_profit numeric(78,0) NOT NULL,
    usdc_sent_to_trader numeric(78,0) NOT NULL,
    percentage_closed integer NOT NULL,
    open_order_id numeric(78,0) NOT NULL,
    close_order_id numeric(78,0) NOT NULL,
    opened_at integer NOT NULL,
    closed_at integer NOT NULL,
    close_tx_hash text NOT NULL,
    PRIMARY KEY (trade_id)
);

CREATE TABLE lp_activity (
    id text NOT NULL,
    owner text NOT NULL,
    kind text NOT NULL,
    settlement_id integer NOT NULL,
    amount numeric(78,0) NOT NULL,
    "timestamp" integer NOT NULL,
    block_number numeric(78,0) NOT NULL,
    tx_hash text NOT NULL,
    PRIMARY KEY (id)
);

CREATE TABLE candle (
    id text NOT NULL,
    pair_index integer NOT NULL,
    "interval" text NOT NULL,
    bucket_start integer NOT NULL,
    open numeric(78,0) NOT NULL,
    high numeric(78,0) NOT NULL,
    low numeric(78,0) NOT NULL,
    close numeric(78,0) NOT NULL,
    volume numeric(78,0) NOT NULL,
    PRIMARY KEY (id)
);

CREATE TABLE sync_status (
    chain_id integer NOT NULL,
    block_number numeric(78,0) NOT NULL,
    block_timestamp integer NOT NULL,
    PRIMARY KEY (chain_id)
);

-- Added 2026-09-28 (spec 2026-09-28-testnet-perfect-design.md §9.1): captured the same way,
-- with `pg_dump --schema-only -t limit_order -t order_event -t fee_charge -t liquidation
-- -t vault_settlement` against a database `ponder start` had just created from
-- services/indexer/ponder.schema.ts (against a local anvil with chain id 1874). Triggers
-- and Ponder's reorg functions omitted, as above; indexes kept because the routes rely on them.

CREATE TABLE limit_order (
    id text NOT NULL,
    trader text NOT NULL,
    pair_index integer NOT NULL,
    index integer NOT NULL,
    order_type text NOT NULL,
    buy boolean NOT NULL,
    collateral numeric(78,0) NOT NULL,
    leverage integer NOT NULL,
    trigger_price numeric(78,0) NOT NULL,
    tp numeric(78,0) NOT NULL,
    sl numeric(78,0) NOT NULL,
    placed_at integer NOT NULL,
    updated_at integer NOT NULL,
    placed_tx text NOT NULL,
    PRIMARY KEY (id)
);
CREATE INDEX limit_order_trader_index ON limit_order USING btree (trader);

CREATE TABLE order_event (
    id text NOT NULL,
    trader text NOT NULL,
    pair_index integer NOT NULL,
    index integer NOT NULL,
    kind text NOT NULL,
    order_type text,
    buy boolean,
    collateral numeric(78,0),
    leverage integer,
    trigger_price numeric(78,0),
    tp numeric(78,0),
    sl numeric(78,0),
    order_id numeric(78,0),
    trade_id numeric(78,0),
    at integer NOT NULL,
    block_number numeric(78,0) NOT NULL,
    tx_hash text NOT NULL,
    PRIMARY KEY (id)
);
CREATE INDEX order_event_trader_at_index ON order_event USING btree (trader, at);

CREATE TABLE fee_charge (
    id text NOT NULL,
    trader text NOT NULL,
    trade_id numeric(78,0),
    pair_index integer,
    kind text NOT NULL,
    amount numeric(78,0) NOT NULL,
    at integer NOT NULL,
    block_number numeric(78,0) NOT NULL,
    tx_hash text NOT NULL,
    PRIMARY KEY (id)
);
CREATE INDEX fee_charge_trader_at_index ON fee_charge USING btree (trader, at);

CREATE TABLE liquidation (
    order_id numeric(78,0) NOT NULL,
    trade_id numeric(78,0) NOT NULL,
    trader text NOT NULL,
    liquidation_fee numeric(78,0) NOT NULL,
    at integer NOT NULL,
    tx_hash text NOT NULL,
    PRIMARY KEY (order_id)
);

CREATE TABLE vault_settlement (
    id integer NOT NULL,
    settlement_type text,
    settlement_ts integer,
    total_assets numeric(78,0),
    total_supply numeric(78,0),
    share_to_assets_price numeric(78,0) NOT NULL,
    settlement_open_pnl numeric(78,0),
    total_closed_pnl numeric(78,0),
    acc_pnl_per_token_used numeric(78,0),
    buffer_size numeric(78,0),
    assets_deposited numeric(78,0),
    shares_withdrawn numeric(78,0),
    delta_shares numeric(78,0),
    at integer NOT NULL,
    block_number numeric(78,0) NOT NULL,
    tx_hash text NOT NULL,
    PRIMARY KEY (id)
);

-- Added with partial-close PnL, captured the same way (pg_dump -t partial_close).
CREATE TABLE partial_close (
    order_id numeric(78,0) NOT NULL,
    trade_id numeric(78,0) NOT NULL,
    trader text NOT NULL,
    pair_index integer NOT NULL,
    index integer NOT NULL,
    buy boolean NOT NULL,
    collateral numeric(78,0) NOT NULL,
    leverage integer NOT NULL,
    open_price numeric(78,0) NOT NULL,
    close_price numeric(78,0) NOT NULL,
    close_reason text NOT NULL,
    percent_profit numeric(78,0) NOT NULL,
    usdc_sent_to_trader numeric(78,0) NOT NULL,
    percentage_closed integer NOT NULL,
    opened_at integer NOT NULL,
    closed_at integer NOT NULL,
    close_tx_hash text NOT NULL,
    PRIMARY KEY (order_id)
);
CREATE INDEX partial_close_trader_index ON partial_close USING btree (trader);

-- Season-one points tables (ponder.schema.ts). Added following Ponder's deterministic column
-- mapping (bigint -> numeric(78,0), hex/text -> text, integer -> integer), matching the rest
-- of this mirror; regenerate with the same pg_dump session when the schema next changes.
CREATE TABLE points_event (
    id text NOT NULL,
    trader text NOT NULL,
    component text NOT NULL,
    points_raw numeric(78,0) NOT NULL,
    requested_raw numeric(78,0) NOT NULL,
    day_index integer NOT NULL,
    ref_id text NOT NULL,
    at integer NOT NULL,
    tx_hash text NOT NULL,
    PRIMARY KEY (id)
);
CREATE INDEX points_event_trader_index ON points_event USING btree (trader);
CREATE INDEX points_event_trader_component_day_index ON points_event USING btree (trader, component, day_index);

CREATE TABLE wallet_points (
    trader text NOT NULL,
    missions_raw numeric(78,0) NOT NULL,
    time_raw numeric(78,0) NOT NULL,
    streak_raw numeric(78,0) NOT NULL,
    lp_raw numeric(78,0) NOT NULL,
    total_raw numeric(78,0) NOT NULL,
    updated_at integer NOT NULL,
    PRIMARY KEY (trader)
);
CREATE INDEX wallet_points_total_index ON wallet_points USING btree (total_raw);

CREATE TABLE points_daily (
    id text NOT NULL,
    trader text NOT NULL,
    component text NOT NULL,
    day_index integer NOT NULL,
    accrued_raw numeric(78,0) NOT NULL,
    PRIMARY KEY (id)
);

CREATE TABLE wallet_streak (
    trader text NOT NULL,
    last_qualified_day integer NOT NULL,
    current_length integer NOT NULL,
    longest integer NOT NULL,
    updated_at integer NOT NULL,
    PRIMARY KEY (trader)
);

CREATE TABLE wallet_lp (
    owner text NOT NULL,
    balance_raw numeric(78,0) NOT NULL,
    last_accrual_at integer NOT NULL,
    PRIMARY KEY (owner)
);
