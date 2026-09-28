import { PRICE_DECIMALS_NUM } from '@/lib/config';
import { formatMoney } from '@/lib/money';
import styles from './OrderPanel.module.css';

export type RiskKey = 'liq' | 'sl' | 'entry' | 'tp';

export interface RiskMarker {
  key: RiskKey;
  label: string;
  value: bigint;
  /** 0–100: where the marker sits between the lowest and highest level shown. */
  pct: number;
}

const LABEL: Record<RiskKey, string> = { liq: 'Liq.', sl: 'SL', entry: 'Entry', tp: 'TP' };

/**
 * The levels of an order on one scale, lowest price first. A level that is not set (a zero
 * TP or SL — the contract's own "none") is left off rather than drawn at zero, which would
 * crush every other marker against the far end.
 *
 * `pct` is display-only pixel math: the ratio of two exact bigint prices converted to a JS
 * number to place a dot. It never reaches a money formatter or a transaction — see the
 * boundary note in src/lib/money.ts.
 */
export function riskMarkers(levels: Partial<Record<RiskKey, bigint | null>>): RiskMarker[] {
  const present = (Object.keys(LABEL) as RiskKey[])
    .map((key) => ({ key, value: levels[key] ?? null }))
    .filter((l): l is { key: RiskKey; value: bigint } => l.value !== null && l.value > 0n);
  if (present.length === 0) return [];
  let lo = present[0]!.value;
  let hi = present[0]!.value;
  for (const l of present) {
    if (l.value < lo) lo = l.value;
    if (l.value > hi) hi = l.value;
  }
  const span = hi - lo;
  return present
    .map((l) => ({
      key: l.key,
      label: LABEL[l.key],
      value: l.value,
      pct: span === 0n ? 50 : (Number(l.value - lo) / Number(span)) * 100,
    }))
    .sort((a, b) => (a.value < b.value ? -1 : a.value > b.value ? 1 : 0));
}

/**
 * Where the order's liquidation, stop, entry and take-profit sit relative to each other —
 * the ticket's "risk preview". Shown only once there is an entry and a liquidation price to
 * anchor it; a scale with one point says nothing.
 */
export function RiskPreview({ entry, liq, tp, sl }: { entry: bigint; liq: bigint | null; tp: bigint | null; sl: bigint | null }) {
  if (entry <= 0n || liq === null || liq <= 0n) return null;
  const markers = riskMarkers({ liq, sl, entry, tp });

  return (
    <div className={styles.risk} data-testid="risk-preview">
      <span className={styles.riskTitle}>Risk preview</span>
      <div className={styles.riskTrack}>
        {markers.map((m) => (
          <span
            key={m.key}
            className={`${styles.riskDot} ${styles[`risk_${m.key}`]}`}
            style={{ left: `calc(${m.pct.toFixed(1)}% - 6px)` }}
            data-testid={`risk-${m.key}`}
          />
        ))}
      </div>
      <div className={styles.riskLegend}>
        {markers.map((m) => (
          <span key={m.key} className={styles[`risk_${m.key}`]}>
            {m.label}
            <br />
            {formatMoney(m.value, PRICE_DECIMALS_NUM, { fractionDigits: 0 })}
          </span>
        ))}
      </div>
    </div>
  );
}
