# @whitespace/txsender

One transaction sender per signing key, shared by the keeper and the automation bot.

```js
import { createTxSender, createDeadLetterStore } from '@whitespace/txsender';

const sender = createTxSender({
  publicClient, walletClient, account,          // viem clients (or mocks)
  deadLetter: createDeadLetterStore({ filePath: '/var/lib/whitespace/keeper-dead-letter.jsonl' }),
  registry,                                     // @whitespace/metrics registry
  metricsPrefix: 'keeper',
});
const result = await sender.send({ to, data, key: 'order-42', meta: { orderId: '42' } });
```

Behaviour:

- **Serial queue.** Every `send` runs to completion (mined or given up) before the next
  starts, so concurrent callers never share a nonce.
- **Legacy type-0** transactions at `eth_gasPrice`.
- **Receipt timeout** (`receiptTimeoutMs`, default 30 s). On timeout the same nonce is
  re-broadcast at 1.2x gas (or the network price, whichever is higher), at most `maxBumps`
  (default 3) times. Every hash sent for that nonce is polled.
- **Reverts consume the nonce.** The local nonce advances on any mined receipt.
- **`nonce too low` / `already known`** resync the nonce from the `pending` tag.
- **Bounded retries** (`maxRetries`, default 3; reverts are retried unless
  `retryOnRevert: false`), then a **dead letter**: JSON Lines appended to `filePath`, with
  only the newest `tailSize` (default 100) unresolved entries held in memory.
  `retryDeadLetters()` re-sends them and records a `resolved` line for each that lands.

Metrics (`<prefix>_…`): `tx_sent_total`, `tx_replaced_total`, `tx_confirmed_total`,
`tx_reverted_total`, `tx_dead_lettered_total`, `nonce_resyncs_total`, `dead_letter_depth`,
`queue_depth`.
