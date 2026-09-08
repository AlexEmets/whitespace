import { ponder } from 'ponder:registry';
import { priceRequest, priceReport } from '../../ponder.schema.js';
import { recordTick } from '../lib/candleTick.js';
import { updateIfExists } from '../lib/db.js';

// Phase 1 of the two-phase order flow (design §5.1): a price was requested.
// PriceRequestedV2 does not carry pairIndex directly (only a feed id) — the
// pairIndex is filled in once the matching PriceReceived arrives, or left
// null if it never does (e.g. a request that times out before a report).
ponder.on('PriceUpKeep:PriceRequestedV2', async ({ event, context }) => {
  await context.db
    .insert(priceRequest)
    .values({
      orderId: event.args.orderId,
      pairIndex: null,
      orderType: event.args.orderType,
      feedId: event.args.feed,
      requestedAt: Number(event.args.timestamp),
      blockNumber: event.block.number,
      txHash: event.transaction.hash,
    })
    .onConflictDoUpdate({
      orderType: event.args.orderType,
      feedId: event.args.feed,
    });
});

// Phase 2: a signed price report was delivered and verified on-chain. This
// is also a tick in the per-pair OHLCV candle series (design: "Derive
// candles from the price reports and/or executed trades").
ponder.on('PriceUpKeep:PriceReceived', async ({ event, context }) => {
  const pairIndex = Number(event.args.pairIndex);
  const price = BigInt(event.args.price); // int192, PRECISION_18

  await context.db
    .insert(priceReport)
    .values({
      orderId: event.args.orderId,
      pairIndex,
      price,
      nativeFee: event.args.nativeFee,
      blockNumber: event.block.number,
      blockTimestamp: Number(event.block.timestamp),
      txHash: event.transaction.hash,
    })
    .onConflictDoUpdate({ nativeFee: event.args.nativeFee });

  // Best-effort backfill: the request row may predate startBlock or simply
  // not exist; the report itself is recorded above regardless.
  await updateIfExists(
    context.db,
    priceRequest,
    { orderId: event.args.orderId },
    { pairIndex },
    'PriceReceived->priceRequest.pairIndex backfill',
  );

  // Pure price tick — no trade volume attached to a report by itself.
  await recordTick(context.db, pairIndex, Number(event.block.timestamp), price, 0n);
});
