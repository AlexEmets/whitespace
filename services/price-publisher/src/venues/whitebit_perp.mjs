/**
 * WhiteBIT's perpetual book, as a source distinct from its spot book.
 *
 * Same host, same `depth_subscribe` protocol, same incremental-diff semantics — only the
 * market symbol differs (`WBT_PERP` rather than `WBT_USDT`). Verified live 2026-09-22:
 * one socket to wss://api.whitebit.com/ws accepted subscriptions for both and streamed
 * `depth_update` frames for each, tagged by market in `params[2]`.
 *
 * So this module deliberately holds no parsing logic of its own. Re-exporting whitebit's
 * parser rather than copying it means a protocol fix lands in both books at once; the only
 * thing that must differ is `id`, which is what keys the tick in the aggregator and what
 * makes the two books count as two sources instead of overwriting each other.
 *
 * Why a separate source at all, rather than one WhiteBIT feed: see MARKET_BOUNDS_OVERRIDES
 * in @whitespace/shared/bounds. This is book-level redundancy for a market no other
 * exchange quotes inside the spread bound — not venue diversity, and not a substitute for
 * it on markets that have real alternatives.
 */

import * as whitebit from './whitebit.mjs';

export const id = 'whitebit_perp';

export const wsUrl = whitebit.wsUrl;
export const subscribePayload = whitebit.subscribePayload;
export const createBook = whitebit.createBook;
export const parseMessage = whitebit.parseMessage;
