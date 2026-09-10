import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { DocsArticle } from '@/components/docs/DocsArticle';
import { DEPLOYMENT_1874 } from '@/lib/deployment';

/**
 * The docs page makes claims about how a trader's money is handled, so the things worth
 * pinning are (a) that its parameters come from the live contract reads rather than from
 * prose, (b) that a failed read degrades to a dash instead of to a confident wrong number,
 * and (c) that the mockups' marketing figures never leak into it.
 */

const paramsAvailable = vi.hoisted(() => ({ value: true }));

vi.mock('@/hooks/useProtocolParams', () => ({
  useProtocolParams: () =>
    paramsAvailable.value
      ? {
          // The values actually read from 1874 on 2026-09-10.
          threshold: 3n,
          signerCount: 5n,
          maxAgeSeconds: 10,
          maxDeviationBps: 500,
          marketOrdersTimeoutBlocks: 30,
          liqMarginThresholdP: 25,
          loading: false,
        }
      : {
          threshold: null,
          signerCount: null,
          maxAgeSeconds: null,
          maxDeviationBps: null,
          marketOrdersTimeoutBlocks: null,
          liqMarginThresholdP: null,
          loading: false,
        },
}));

vi.mock('@/hooks/useMarketFees', () => ({
  useMarketFees: () => ({ makerFeeRaw: 0n, takerFeeRaw: 0n, oracleFeeRaw: 1_000000n, loading: false }),
}));

vi.mock('@/hooks/useMarkets', () => ({
  useMarkets: () => ({
    markets: [
      {
        pairIndex: 0,
        from: 'BTC',
        to: 'USD',
        feedId: '0x0',
        maxLeverage: '100.00',
        maxOpenInterest: '1000000.000000',
        openInterest: { long: '0.000000', short: '0.000000' },
      },
    ],
    loading: false,
    error: null,
  }),
}));

describe('<DocsArticle>', () => {
  it('covers every topic a trader has to understand before depositing', () => {
    paramsAvailable.value = true;
    render(<DocsArticle />);
    for (const id of ['model', 'lifecycle', 'slippage', 'margin', 'oracle', 'fees', 'contracts', 'limits']) {
      expect(screen.getByTestId(`docs-section-${id}`)).toBeInTheDocument();
    }
  });

  it('quotes the oracle threshold from the live contract read', () => {
    paramsAvailable.value = true;
    render(<DocsArticle />);
    expect(screen.getByTestId('oracle-threshold')).toHaveTextContent('3');
    expect(screen.getByTestId('oracle-signers')).toHaveTextContent('5');
  });

  it('shows a dash, not a documented default, when a parameter cannot be read', () => {
    paramsAvailable.value = false;
    render(<DocsArticle />);
    // The design spec says k=3 — but if the chain did not answer, the page must not repeat
    // the spec as though it had been verified. Three documents disagree about this exact
    // value, which is why it is read rather than transcribed.
    expect(screen.getByTestId('oracle-threshold')).toHaveTextContent('—');
    expect(screen.getByTestId('oracle-signers')).toHaveTextContent('—');
    paramsAvailable.value = true;
  });

  it('lists the live contract addresses from deployments/1874.json, linked to the explorer', () => {
    paramsAvailable.value = true;
    render(<DocsArticle />);
    expect(screen.getByTestId('docs-contract-trading')).toHaveTextContent(DEPLOYMENT_1874.contracts.trading);
    expect(screen.getByTestId('docs-contract-verifier')).toHaveTextContent(DEPLOYMENT_1874.contracts.verifier);

    const vaultLink = screen.getByTestId('docs-contract-vault').querySelector('a');
    expect(vaultLink).toHaveAttribute(
      'href',
      `https://explorer.testnet.whitechain.io/address/${DEPLOYMENT_1874.contracts.vault}`,
    );
    // Opening an external explorer must not hand it a window reference back.
    expect(vaultLink?.getAttribute('rel')).toContain('noopener');
  });

  it('explains the two-phase lifecycle and the refund-minus-oracle-fee outcome', () => {
    paramsAvailable.value = true;
    const { container } = render(<DocsArticle />);
    const text = container.textContent ?? '';
    expect(text).toMatch(/you do not have a position/i);
    expect(text).toMatch(/minus the oracle fee/i);
    expect(text).toMatch(/openTradeMarketTimeout/);
    expect(text).toMatch(/1\.00 USDW/);
  });

  it('states the slippage default from the app\'s own constant', () => {
    paramsAvailable.value = true;
    const { container } = render(<DocsArticle />);
    expect(container.textContent ?? '').toMatch(/0\.50%/);
  });

  it('describes liquidation as a value test and keeps the liquidation price unavailable', () => {
    paramsAvailable.value = true;
    const { container } = render(<DocsArticle />);
    const text = container.textContent ?? '';
    expect(text).toMatch(/tradeValue\s*<\s*liqMarginValue/);
    expect(text).toMatch(/isolated/i);
    expect(text).toMatch(/getTradeLiquidationPrice/);
  });

  it('repeats none of the mockups\' marketing figures', () => {
    paramsAvailable.value = true;
    const { container } = render(<DocsArticle />);
    const text = container.textContent ?? '';
    // The live market is 100x, the live taker fee is 0%, and referral was cut from scope.
    expect(text).not.toMatch(/50×\s*(max|leverage)/i);
    expect(text).not.toMatch(/25%\s*of\s*taker/i);
    expect(text).not.toMatch(/0\.035%\s*taker/i);
  });

  it('discloses what is not live rather than burying it', () => {
    paramsAvailable.value = true;
    const { container } = render(<DocsArticle />);
    const text = container.textContent ?? '';
    expect(text).toMatch(/faucet token/i);
    expect(text).toMatch(/has been audited|audited/i);
    expect(text).toMatch(/OstiumTradesUpKeep/);
    expect(text).toMatch(/degraded/i);
  });
});
