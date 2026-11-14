'use client';

import { useId } from 'react';
import { useVaultPerformance } from '@/hooks/useVaultPerformance';
import { utcDate } from '@/lib/shareCard';
import type { VaultPerformanceWindow } from '@/lib/types';
import { formatMoney } from '@/lib/money';
import { formatReturn, isLoss, sharePriceGeometry } from '@/lib/vaultPerformance';
import { Dash, Section, Tile, TileRow, TileUnit } from './portfolio/AccountPage';

/**
 * What an LP has earned, from GET /vault/performance: APR over 7 and 30 days, the return since
 * the vault's first settlement, the share price, and its history as a chart.
 *
 * Every figure is the share price's change between two settlements — nothing is projected.
 * A window the vault is too young for shows a dash with that reason, never a number made up
 * from a shorter one.
 */

const CHART_W = 1000;
const CHART_H = 180;

function Return({ window, field, reason }: { window: VaultPerformanceWindow | null; field: 'apr' | 'change'; reason: string }) {
  if (!window) return <Dash reason={reason} />;
  return <span className={isLoss(window[field]) ? 'neg' : 'pos'}>{formatReturn(window[field])}</span>;
}

function SharePriceChart({ series }: { series: Array<{ t: number; sharePrice: string }> }) {
  const fill = `${useId().replace(/:/g, '')}-share-fill`;
  const geometry = sharePriceGeometry(series, CHART_W, CHART_H);
  if (!geometry) return <p className="vault-hint">The chart starts once the vault has settled on two different days.</p>;
  const first = series[0]!;
  const last = series[series.length - 1]!;
  return (
    <figure className="vault-chart" data-testid="vault-chart">
      <svg
        viewBox={`0 0 ${CHART_W} ${CHART_H}`}
        preserveAspectRatio="none"
        role="img"
        aria-label={`Share price from ${first.sharePrice} on ${utcDate(first.t)} to ${last.sharePrice} on ${utcDate(last.t)}`}
      >
        <defs>
          <linearGradient id={fill} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" style={{ stopColor: 'rgb(var(--accent-rgb))', stopOpacity: 0.22 }} />
            <stop offset="1" style={{ stopColor: 'rgb(var(--accent-rgb))', stopOpacity: 0 }} />
          </linearGradient>
        </defs>
        <line
          x1={0}
          x2={CHART_W}
          y1={geometry.parY}
          y2={geometry.parY}
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
      <figcaption className="vault-chart-axis mono">
        <span>{utcDate(first.t)}</span>
        <span>dashed line: 1 share = 1 USDW</span>
        <span>{utcDate(last.t)}</span>
      </figcaption>
    </figure>
  );
}

export function VaultPerformance() {
  const { performance, error } = useVaultPerformance();
  const reason = error ? 'the vault history could not be loaded' : 'loading the vault history';
  const w = performance?.windows;

  return (
    <>
      <TileRow>
        <Tile
          lead
          label="APR · 7 days"
          testId="vault-apr-7d"
          value={w ? <Return window={w['7d']} field="apr" reason="the vault is younger than 7 days" /> : <Dash reason={reason} />}
        />
        <Tile
          label="APR · 30 days"
          testId="vault-apr-30d"
          value={w ? <Return window={w['30d']} field="apr" reason="the vault is younger than 30 days" /> : <Dash reason={reason} />}
        />
        <Tile
          label="Since launch"
          testId="vault-since-launch"
          value={w ? <Return window={w.all} field="change" reason="the vault has settled only once" /> : <Dash reason={reason} />}
          note={w?.all ? `${formatReturn(w.all.apr)} APR since ${utcDate(w.all.from)}` : undefined}
        />
        <Tile
          label="Share price"
          testId="vault-share-price"
          value={
            performance ? (
              <>
                {formatMoney(performance.sharePrice, 18, { fractionDigits: 4 })}
                <TileUnit>USDW</TileUnit>
              </>
            ) : (
              <Dash reason={reason} />
            )
          }
          note={performance ? `at the settlement of ${utcDate(performance.updatedAt)}` : undefined}
        />
      </TileRow>

      <Section
        title="Share price"
        testId="vault-performance"
        aside="Settled history"
        foot="Testnet. The vault is the other side of every trade, so its return is fees, spread and funding plus the traders' net losses, and it can go negative. APR is the change annualised without compounding; past returns are not a forecast."
      >
        {performance ? <SharePriceChart series={performance.series} /> : <Dash reason={reason} />}
      </Section>
    </>
  );
}
