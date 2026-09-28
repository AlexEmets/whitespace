import { useId } from 'react';

export interface SparklineGeometry {
  /** The step line: flat between closes, a vertical jump at each one. */
  line: string;
  /** The same line closed down to the zero baseline, for the fill. */
  area: string;
  zeroY: number;
}

/**
 * Lays a running total out as a step line in a `width`×`height` box.
 *
 * Steps rather than a slope: realised PnL does not drift between closes, it moves only when
 * one settles, and a diagonal would draw gains and losses that never happened. The range
 * always includes zero, so the baseline is on the chart and "above the line" means "up".
 */
export function sparklineGeometry(values: number[], width: number, height: number, pad = 3): SparklineGeometry | null {
  if (values.length < 2) return null;

  const lo = Math.min(0, ...values);
  const hi = Math.max(0, ...values);
  const span = hi - lo || 1;
  const x = (i: number) => pad + (i * (width - 2 * pad)) / (values.length - 1);
  const y = (v: number) => pad + ((hi - v) * (height - 2 * pad)) / span;
  const r = (n: number) => Math.round(n * 100) / 100;

  const [first = 0, ...rest] = values;
  let line = `M${r(x(0))} ${r(y(first))}`;
  rest.forEach((value, i) => {
    line += ` H${r(x(i + 1))} V${r(y(value))}`;
  });
  const zeroY = r(y(0));
  return { line, area: `${line} V${zeroY} H${r(x(0))} Z`, zeroY };
}

const WIDTH = 320;
const HEIGHT = 48;

/** The cumulative realised PnL under the performance card. `values` are USDW. */
export function PnlSparkline({ values }: { values: number[] }) {
  const fill = `${useId().replace(/:/g, '')}-spark-fill`;
  const geometry = sparklineGeometry(values, WIDTH, HEIGHT);
  if (!geometry) return null;

  return (
    <svg
      className="pnl-sparkline"
      viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
      preserveAspectRatio="none"
      role="img"
      aria-label={`Realised PnL over ${values.length - 1} closes, ending at ${(values.at(-1) ?? 0).toFixed(2)} USDW`}
      data-testid="pnl-sparkline"
    >
      <defs>
        <linearGradient id={fill} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" style={{ stopColor: 'rgb(var(--accent-rgb))', stopOpacity: 0.22 }} />
          <stop offset="1" style={{ stopColor: 'rgb(var(--accent-rgb))', stopOpacity: 0 }} />
        </linearGradient>
      </defs>
      <line
        x1={0}
        x2={WIDTH}
        y1={geometry.zeroY}
        y2={geometry.zeroY}
        vectorEffect="non-scaling-stroke"
        style={{ stroke: 'var(--border-strong)', strokeDasharray: '3 4' }}
      />
      <path d={geometry.area} fill={`url(#${fill})`} />
      <path
        d={geometry.line}
        vectorEffect="non-scaling-stroke"
        style={{ fill: 'none', stroke: 'var(--accent)', strokeWidth: 1.6, strokeLinejoin: 'round' }}
      />
    </svg>
  );
}
