/**
 * Wires the keeper together from a loaded config and viem-shaped clients: tx sender,
 * report source, engine, persisted cursor, watcher, metrics and health. Kept apart from
 * main.mjs (which only builds real clients and installs signal handlers) so the wiring —
 * that the polling interval, cursor and lookback actually reach the watcher, and that
 * outcomes reach the metrics — is unit-tested with fakes.
 */

import { createRegistry } from '@whitespace/metrics';
import { createDeadLetterStore } from '@whitespace/txsender';
import { createTxSender } from './txSender.mjs';
import { createKeeperEngine } from './keeperEngine.mjs';
import { createCursorStore } from './cursorStore.mjs';
import { createHttpReportSource } from './reportSource.mjs';
import { watchPriceRequested } from './watcher.mjs';

/** /health turns 503 when the last successful poll is older than this many intervals. */
export const HEALTH_STALE_POLLS = 10;
export const HEALTH_STALE_MIN_MS = 30_000;

/**
 * @param {object} opts
 * @param {ReturnType<typeof import('./config.mjs').loadConfig>} opts.config
 * @param {object} opts.publicClient
 * @param {object} opts.walletClient
 * @param {{ address: `0x${string}` }} opts.account
 * @param {object} [opts.reportSource] defaults to the HTTP publisher at config.publisherBaseUrl
 * @param {typeof watchPriceRequested} [opts.watch]
 * @param {{ log: Function, warn: Function, error: Function }} [opts.logger]
 * @param {() => number} [opts.now]
 */
export function createKeeper({
  config,
  publicClient,
  walletClient,
  account,
  reportSource = createHttpReportSource(config.publisherBaseUrl),
  watch = watchPriceRequested,
  logger = console,
  now = () => Date.now(),
}) {
  const registry = createRegistry();
  const m = {
    requests: registry.counter('keeper_price_requests_total', 'PriceRequestedV2 events handled'),
    delivered: registry.counter('keeper_orders_delivered_total', 'Orders whose performUpkeep mined successfully'),
    failed: registry.counter('keeper_orders_failed_total', 'Orders whose performUpkeep was dead-lettered'),
    reportRetries: registry.counter('keeper_report_retries_total', 'Report fetches retried (publisher down or refusing)'),
    gaveUp: registry.counter('keeper_orders_given_up_total', 'Orders with no report before their deadline'),
    handlerErrors: registry.counter('keeper_watcher_errors_total', 'Watcher poll or handler errors'),
    cursor: registry.gauge('keeper_cursor_block', 'Next block the watcher will scan'),
    head: registry.gauge('keeper_head_block', 'Chain head at the last poll'),
    pollAge: registry.gauge('keeper_last_poll_age_seconds', 'Seconds since the last successful poll (-1 before the first)'),
  };

  const deadLetter = createDeadLetterStore({ filePath: config.deadLetterFilePath });
  const txSender = createTxSender({
    publicClient,
    walletClient,
    account,
    priceUpKeepAddress: config.priceUpKeepAddress,
    deadLetter,
    registry,
    maxRetries: config.maxRetries,
    ...(config.receiptTimeoutMs ? { receiptTimeoutMs: config.receiptTimeoutMs } : {}),
    ...(config.maxGasBumps !== undefined ? { maxBumps: config.maxGasBumps } : {}),
    log: (level, message) => logger[level === 'error' ? 'error' : 'warn'](`[keeper] ${message}`),
  });

  const engine = createKeeperEngine({
    reportSource,
    txSender,
    now,
    onRetry: ({ orderId, reason, attempt, waitMs }) => {
      m.reportRetries.inc();
      logger.warn(`[keeper] orderId=${orderId} report attempt ${attempt} refused (${reason}), retrying in ${waitMs}ms`);
    },
    onGiveUp: ({ orderId, reason }) => {
      m.gaveUp.inc();
      logger.error(`[keeper] orderId=${orderId} GAVE UP: ${reason}`);
    },
  });

  const cursorStore = createCursorStore(config.cursorPath, {
    onCorrupt: (err) => logger.error(`[keeper] cursor file unreadable, starting at the head: ${err.message}`),
  });

  async function onEvent(event) {
    m.requests.inc();
    logger.log(`[keeper] PriceRequestedV2 orderId=${event.orderId} type=${event.orderTypeName} feed=${event.feed} timestamp=${event.timestamp}`);
    const result = await engine.handlePriceRequested(event);
    if (result.ok) {
      m.delivered.inc();
      logger.log(`[keeper] orderId=${event.orderId} delivered, tx=${result.hash}`);
    } else if (!result.gaveUp) {
      m.failed.inc();
      logger.error(`[keeper] orderId=${event.orderId} FAILED: ${result.reason}`);
    }
  }

  let unwatch = null;
  const staleAfterMs = Math.max(HEALTH_STALE_MIN_MS, HEALTH_STALE_POLLS * config.pollingIntervalMs);

  function start() {
    if (unwatch) return;
    const startBlock = cursorStore.load();
    logger.log(`[keeper] cursor=${config.cursorPath ?? '(not persisted)'} resume=${startBlock ?? 'head'} pollingIntervalMs=${config.pollingIntervalMs}`);
    unwatch = watch(
      publicClient,
      config.priceUpKeepAddress,
      onEvent,
      (err) => {
        m.handlerErrors.inc();
        logger.error('[keeper] watcher error:', err.message);
      },
      {
        pollIntervalMs: config.pollingIntervalMs,
        startBlock,
        maxLookbackBlocks: config.maxLookbackBlocks,
        concurrency: config.concurrency,
        onCursor: (next) => cursorStore.save(next),
        now,
      },
    );
  }

  function stop() {
    unwatch?.();
    unwatch = null;
  }

  function health() {
    const state = unwatch?.state?.() ?? { cursor: null, head: null, lastSuccessAt: null };
    const lastPollAgeMs = state.lastSuccessAt === null ? null : now() - state.lastSuccessAt;
    const ok = lastPollAgeMs !== null && lastPollAgeMs <= staleAfterMs;
    return {
      ok,
      cursor: state.cursor,
      head: state.head,
      lastPollAgeMs,
      staleAfterMs,
      nonce: txSender.nonce,
      queued: txSender.sender.queued,
      deadLetters: deadLetter.size(),
    };
  }

  function renderMetrics() {
    const h = health();
    if (h.cursor !== null) m.cursor.set(Number(h.cursor));
    if (h.head !== null) m.head.set(Number(h.head));
    m.pollAge.set(h.lastPollAgeMs === null ? -1 : h.lastPollAgeMs / 1000);
    return registry.render();
  }

  return { start, stop, health, renderMetrics, registry, metrics: m, engine, txSender, deadLetter };
}
