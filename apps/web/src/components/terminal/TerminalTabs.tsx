'use client';

import { useState } from 'react';
import { FillsList } from '@/components/FillsList';
import { OrdersList } from '@/components/OrdersList';
import { PositionsList } from '@/components/PositionsList';

const TABS = ['positions', 'orders', 'fills', 'funding'] as const;
type Tab = (typeof TABS)[number];

const TAB_LABELS: Record<Tab, string> = {
  positions: 'Positions',
  orders: 'Open orders',
  fills: 'Fills',
  funding: 'Funding',
};

/** Bottom tabbed table: Positions / Open orders / Fills / Funding. Funding has no
 * backing endpoint in the read API — shown as an explicit "coming soon" tab rather than
 * fabricated rows. */
export function TerminalTabs() {
  const [tab, setTab] = useState<Tab>('positions');

  return (
    <div className="terminal-tabs" data-testid="terminal-tabs">
      <div className="tab-bar">
        {TABS.map((t) => (
          <button key={t} type="button" className={tab === t ? 'active' : ''} onClick={() => setTab(t)} data-testid={`tab-${t}`}>
            {TAB_LABELS[t]}
          </button>
        ))}
      </div>
      <div className="tab-content">
        {tab === 'positions' ? <PositionsList /> : null}
        {tab === 'orders' ? <OrdersList /> : null}
        {tab === 'fills' ? <FillsList /> : null}
        {tab === 'funding' ? (
          <p className="dash" data-testid="funding-coming-soon">
            Funding history is not available yet — no funding endpoint in the read API.
          </p>
        ) : null}
      </div>
    </div>
  );
}
