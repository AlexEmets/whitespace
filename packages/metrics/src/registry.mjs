/**
 * A tiny, dependency-free Prometheus-style text-exposition registry.
 *
 * Deliberately its own package (not under services/liquidator) so services/keeper and
 * services/price-publisher can depend on it too, without depending on the liquidator —
 * see docs/decisions/phase-6-liquidator.md for why, and for the (not yet made, purely
 * additive) integration those two services would need to actually emit metrics. This
 * package does not modify either of them.
 *
 * No timers, no HTTP, no I/O: a registry is just counters and gauges in memory plus a
 * pure `render()` that turns them into the text format Prometheus scrapes
 * (https://prometheus.io/docs/instrumenting/exposition_formats/), so it is fully
 * unit-testable without a socket.
 */

function labelKey(labels) {
  const keys = Object.keys(labels).sort();
  return keys.map((k) => `${k}=${JSON.stringify(String(labels[k]))}`).join(',');
}

function renderLabels(labels) {
  const keys = Object.keys(labels).sort();
  if (keys.length === 0) return '';
  return `{${keys.map((k) => `${k}=${JSON.stringify(String(labels[k]))}`).join(',')}}`;
}

class Metric {
  constructor(name, help, type) {
    this.name = name;
    this.help = help;
    this.type = type;
    /** @type {Map<string, { labels: Record<string,string>, value: number }>} */
    this.series = new Map();
  }

  _set(labels, value) {
    const key = labelKey(labels);
    this.series.set(key, { labels, value });
  }

  _get(labels) {
    return this.series.get(labelKey(labels))?.value ?? 0;
  }

  render() {
    const lines = [`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} ${this.type}`];
    if (this.series.size === 0) return lines.join('\n');
    for (const { labels, value } of this.series.values()) {
      lines.push(`${this.name}${renderLabels(labels)} ${value}`);
    }
    return lines.join('\n');
  }
}

export class Counter extends Metric {
  constructor(name, help) {
    super(name, help, 'counter');
  }

  /** @param {number} [value] @param {Record<string,string>} [labels] */
  inc(value = 1, labels = {}) {
    if (value < 0) throw new Error(`Counter.inc: value must be >= 0, got ${value}`);
    this._set(labels, this._get(labels) + value);
  }

  value(labels = {}) {
    return this._get(labels);
  }
}

export class Gauge extends Metric {
  constructor(name, help) {
    super(name, help, 'gauge');
  }

  /** @param {number} value @param {Record<string,string>} [labels] */
  set(value, labels = {}) {
    this._set(labels, value);
  }

  inc(value = 1, labels = {}) {
    this._set(labels, this._get(labels) + value);
  }

  dec(value = 1, labels = {}) {
    this._set(labels, this._get(labels) - value);
  }

  value(labels = {}) {
    return this._get(labels);
  }
}

export function createRegistry() {
  /** @type {Metric[]} */
  const metrics = [];

  return {
    /** @param {string} name @param {string} help */
    counter(name, help) {
      const c = new Counter(name, help);
      metrics.push(c);
      return c;
    },
    /** @param {string} name @param {string} help */
    gauge(name, help) {
      const g = new Gauge(name, help);
      metrics.push(g);
      return g;
    },
    /** Prometheus text exposition format (content-type text/plain; version=0.0.4). */
    render() {
      return metrics.map((m) => m.render()).join('\n') + '\n';
    },
  };
}
