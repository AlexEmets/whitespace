/** The parts of a Ponder event the handler logic in src/lib needs, so that logic can be
 * called from tests without Ponder's runtime. */
export type EventMeta = {
  txHash: `0x${string}`;
  logIndex: number;
  blockNumber: bigint;
  timestamp: number;
};

export function toMeta(event: {
  transaction: { hash: `0x${string}` };
  log: { logIndex: number };
  block: { number: bigint; timestamp: bigint };
}): EventMeta {
  return {
    txHash: event.transaction.hash,
    logIndex: event.log.logIndex,
    blockNumber: event.block.number,
    timestamp: Number(event.block.timestamp),
  };
}

/** `${txHash}-${logIndex}` — the spec's per-log primary key. */
export function logId(meta: EventMeta): string {
  return `${meta.txHash}-${meta.logIndex}`;
}
