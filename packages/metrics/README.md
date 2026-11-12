# @whitespace/metrics

A tiny Prometheus-style registry: counters and gauges in memory, and a pure `render()`
that turns them into the text exposition format Prometheus scrapes. No dependencies, no
timers, no HTTP, no I/O. Each service decides where to serve the text.

```js
import { createRegistry } from '@whitespace/metrics';

const registry = createRegistry();
const sent = registry.counter('keeper_orders_delivered_total', 'Orders whose performUpkeep mined');
const head = registry.gauge('keeper_head_block', 'Chain head at the last poll');

sent.inc();                          // +1
sent.inc(1, { ok: 'true' });         // a separate series for that label set
head.set(1_234_567);

res.setHeader('content-type', 'text/plain; version=0.0.4');
res.end(registry.render());
```

## API

`createRegistry()` returns:

| Method | What it does |
|---|---|
| `counter(name, help)` | Creates and registers a `Counter`. |
| `gauge(name, help)` | Creates and registers a `Gauge`. |
| `render()` | Every registered metric in Prometheus text format, in registration order, ending with a newline. |

`Counter` and `Gauge` are also exported as classes.

| Class | Methods |
|---|---|
| `Counter` | `inc(value = 1, labels = {})` throws on a negative value; `value(labels = {})`. |
| `Gauge` | `set(value, labels = {})`, `inc(value = 1, labels = {})`, `dec(value = 1, labels = {})`, `value(labels = {})`. Values may go negative. |

Behaviour:

- **Label-scoped series.** Each distinct label set is its own series; label order does not
  matter. An unseen series reads as `0`.
- **Rendering.** Each metric emits `# HELP` and `# TYPE` lines, then one line per series,
  e.g. `liquidator_batches_total{ok="true"} 3`. Label keys are sorted and values quoted.
  A metric with no series yet still emits its `HELP`/`TYPE` lines.
- **No name checks.** The registry does not validate metric names or reject a name
  registered twice; prefixes such as `keeper_` or `liquidator_` are the caller's choice.

## Consumers

| Consumer | Metrics prefix |
|---|---|
| `services/keeper` | `keeper_…` |
| `services/price-publisher` | `publisher_…`, in `src/metrics.mjs` |
| `services/liquidator` | `liquidator_…`, in `src/metrics.mjs` |
| `packages/txsender` | `<metricsPrefix>_…` on the registry the service passes in (or its own) |

## Tests

```bash
pnpm --filter @whitespace/metrics test   # node --test
```
