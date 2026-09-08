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
