/**
 * Classification of node errors returned by eth_sendRawTransaction. Matched on the
 * message text because that is all a JSON-RPC error reliably carries across geth,
 * op-geth and the proxies in front of them; viem wraps the node message but keeps it
 * in `message`/`details`/`shortMessage`.
 */

function textOf(err) {
  if (err == null) return '';
  if (typeof err === 'string') return err;
  return [err.message, err.details, err.shortMessage, err.cause?.message].filter(Boolean).join(' | ');
}

/** The nonce we used has already been consumed on chain. */
export function isNonceTooLow(err) {
  return /nonce too low|nonce has already been used|nonce_expired|NONCE_EXPIRED/i.test(textOf(err));
}

/** The node already holds this exact transaction in its pool. */
export function isAlreadyKnown(err) {
  return /already known|known transaction|already imported/i.test(textOf(err));
}

/** A same-nonce replacement was refused because its gas price is not high enough. */
export function isUnderpriced(err) {
  return /underpriced/i.test(textOf(err));
}

/** One short line describing an error, for logs and dead-letter entries. */
export function reasonOf(err) {
  if (err == null) return 'unknown';
  if (typeof err === 'string') return err;
  return String(err.shortMessage ?? err.message ?? err).split('\n')[0];
}
