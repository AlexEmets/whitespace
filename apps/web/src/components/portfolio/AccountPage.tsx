'use client';

import type { ReactNode } from 'react';
import styles from './accountPage.module.css';

/**
 * The page shell shared by /portfolio and /points.
 *
 * Both are the same kind of screen — an account-scoped readout of numbers that only exist
 * once a wallet is connected — so they share a head, a tile row, section bands, and above
 * all the four states every such page has to handle: disconnected, loading, failed, and
 * genuinely empty. Writing those four twice is how two pages drift into disagreeing about
 * what "no data" looks like.
 *
 * It lives under components/portfolio/ because that is where the first consumer is; /points
 * imports it rather than growing a second copy.
 */

export function PageHead({
  eyebrow,
  title,
  lede,
  meta,
}: {
  eyebrow: string;
  title: string;
  lede: ReactNode;
  meta?: ReactNode;
}) {
  return (
    <header className={styles.head}>
      <div className={styles.headMain}>
        <div className={`${styles.eyebrow} mono-upper`}>{eyebrow}</div>
        <h1 className={styles.title}>{title}</h1>
        <p className={styles.lede}>{lede}</p>
      </div>
      {meta ? <div className={styles.headMeta}>{meta}</div> : null}
    </header>
  );
}

export function TileRow({ children }: { children: ReactNode }) {
  return <section className={styles.tiles}>{children}</section>;
}

/**
 * One stat tile. `value` is a `ReactNode` and never a raw number: a caller with nothing to
 * show passes `<Dash/>`, which is the app's established way of saying "not available"
 * (see PositionsList's Liq. column) rather than printing a zero that reads as a real
 * measurement.
 */
export function Tile({
  label,
  value,
  note,
  lead = false,
  testId,
}: {
  label: string;
  value: ReactNode;
  note?: ReactNode;
  lead?: boolean;
  testId?: string;
}) {
  return (
    <div className={`${styles.tile}${lead ? ` ${styles.tileLead}` : ''}`} data-testid={testId}>
      <div className={styles.tileLabel}>{label}</div>
      <div className={styles.tileValue}>{value}</div>
      {note ? <div className={styles.tileNote}>{note}</div> : null}
    </div>
  );
}

export function TileUnit({ children }: { children: ReactNode }) {
  return <span className={styles.tileUnit}>{children}</span>;
}

export function Section({
  title,
  note,
  aside,
  foot,
  children,
  testId,
}: {
  title: string;
  note?: ReactNode;
  aside?: ReactNode;
  foot?: ReactNode;
  children: ReactNode;
  testId?: string;
}) {
  return (
    <section className={styles.section} data-testid={testId}>
      <div className={styles.sectionHead}>
        <h2 className={styles.sectionTitle}>{title}</h2>
        {aside ? <div className={styles.sectionNote}>{aside}</div> : null}
      </div>
      {note ? <p className={`${styles.sectionNote}`} style={{ margin: '-0.4rem 0 1.1rem' }}>{note}</p> : null}
      {children}
      {foot ? <p className={styles.sectionFoot}>{foot}</p> : null}
    </section>
  );
}

/**
 * The em-dash the rest of this app uses for a figure it does not have, carrying the reason
 * in its tooltip. Never rendered without one: an unexplained dash is indistinguishable
 * from a bug.
 */
export function Dash({ reason }: { reason: string }) {
  return (
    <span className="dash" title={`Not available: ${reason}`} data-testid="honest-dash">
      —
    </span>
  );
}

export type AccountStateKind = 'disconnected' | 'loading' | 'error' | 'empty';

const STATE_ICON: Record<AccountStateKind, string> = {
  disconnected: '[ NO WALLET ]',
  loading: '[ LOADING ]',
  error: '[ ERROR ]',
  empty: '[ EMPTY ]',
};

/**
 * The one place the four states are rendered, so they are visually the same object on both
 * pages and none of them can end up looking like an accident.
 */
export function AccountState({
  kind,
  title,
  children,
  detail,
}: {
  kind: AccountStateKind;
  title: string;
  children: ReactNode;
  detail?: string;
}) {
  const modifier =
    kind === 'error' ? ` ${styles.stateError}` : kind === 'loading' ? ` ${styles.stateLoading}` : '';
  return (
    <div className={`${styles.state}${modifier}`} data-testid={`account-state-${kind}`} role={kind === 'error' ? 'alert' : 'status'}>
      <div className={`${styles.stateIcon} mono-upper`}>{STATE_ICON[kind]}</div>
      <h3 className={styles.stateTitle}>{title}</h3>
      <div className={styles.stateBody}>{children}</div>
      {detail ? <div className={styles.stateDetail}>{detail}</div> : null}
    </div>
  );
}

export function Defs({ children }: { children: ReactNode }) {
  return <div className={styles.defs}>{children}</div>;
}

export function DefRow({
  label,
  value,
  total = false,
  testId,
}: {
  label: ReactNode;
  value: ReactNode;
  total?: boolean;
  testId?: string;
}) {
  return (
    <div className={`${styles.defRow}${total ? ` ${styles.defTotal}` : ''}`} data-testid={testId}>
      <span className={styles.defKey}>{label}</span>
      <span className={styles.defValue}>{value}</span>
    </div>
  );
}

export { styles as accountStyles };
