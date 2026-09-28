'use client';

import { useState } from 'react';
import { useAccount } from 'wagmi';
import { FillsList } from '@/components/FillsList';
import { OrdersList } from '@/components/OrdersList';
import { PositionsList } from '@/components/PositionsList';
import {
  FundingHistoryList,
  LimitOrdersList,
  OrderHistoryList,
  RealizedPnlPanel,
} from '@/components/terminal/AccountTables';
import { useLimitOrders } from '@/hooks/useAccountHistory';
import { useOrders } from '@/hooks/useOrders';
import { usePositions } from '@/hooks/usePositions';

const TABS = ['positions', 'orders', 'fills', 'history', 'funding', 'pnl'] as const;
type Tab = (typeof TABS)[number];

const TAB_LABELS: Record<Tab, string> = {
  positions: 'Positions',
  orders: 'Open orders',
  fills: 'Trade history',
  history: 'Order history',
  funding: 'Funding history',
  pnl: 'Realized PnL',
};

/** Bottom tabbed tables, as Variational's terminal lays them out: Positions, Open Orders
 * (in-flight market orders and resting limit/stop entries), Trade History, Order History,
 * Funding History and Realized PnL. */
export function TerminalTabs() {
  const [tab, setTab] = useState<Tab>('positions');
  const { address } = useAccount();
  const { positions } = usePositions(address);
  const { orders } = useOrders(address);
  const { limitOrders } = useLimitOrders(address);

  // The mockup labels these "POSITIONS · 2", "OPEN ORDERS · 3" — a count is the reason to
  // look at a tab you are not currently on. Only for tabs whose contents this app actually
  // knows: Fills and Funding get no badge rather than a fabricated zero.
  //
  // Orders counts only the PENDING ones. /orders also returns recently resolved orders now
  // (so the fill/cancel outcome stays visible), but a badge saying "3" over a tab holding
  // two finished orders would misreport how much is actually outstanding.
  const counts: Partial<Record<Tab, number>> = address
    ? {
        positions: positions.length,
        orders: orders.filter((o) => o.status === 'pending').length + limitOrders.length,
      }
    : {};

  return (
    <div className="terminal-tabs" data-testid="terminal-tabs">
      <div className="tab-bar">
        {TABS.map((t) => (
          <button key={t} type="button" className={tab === t ? 'active' : ''} onClick={() => setTab(t)} data-testid={`tab-${t}`}>
            {TAB_LABELS[t]}
            {counts[t] !== undefined && counts[t]! > 0 ? (
              <span className="tab-count" data-testid={`tab-count-${t}`}>
                · {counts[t]}
              </span>
            ) : null}
          </button>
        ))}
      </div>
      <div className="tab-content">
        {tab === 'positions' ? <PositionsList /> : null}
        {tab === 'orders' ? (
          <>
            <LimitOrdersList />
            <OrdersList />
          </>
        ) : null}
        {tab === 'fills' ? <FillsList /> : null}
        {tab === 'history' ? <OrderHistoryList /> : null}
        {tab === 'funding' ? <FundingHistoryList /> : null}
        {tab === 'pnl' ? <RealizedPnlPanel /> : null}
      </div>
    </div>
  );
}
