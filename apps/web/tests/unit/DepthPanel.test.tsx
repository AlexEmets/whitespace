import { render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DepthPanel } from '@/components/terminal/DepthPanel';

/**
 * Drives the real `usePriceImpactLadder` + `src/lib/priceImpact.ts` through the panel, with
 * only the two external boundaries mocked: the wagmi contract reads and the price hook.
 * The rendered strings below are therefore the actual output of the transcribed Solidity,
 * cross-checked against the same hand-computed values as tests/unit/priceImpact.test.ts.
 */

const E18 = 10n ** 18n;

interface ChainMock {
  priceImpactK: bigint;
  netVolThreshold: bigint;
  decayRate: bigint;
  buyVolume: bigint;
  sellVolume: bigint;
  lastUpdateTimestamp: number;
  /** A per-call revert: the query resolves, individual entries report failure. */
  failed: boolean;
  /** A transport failure (RPC down / rate-limited): no `data` at all, only `error`. */
  transportFailed: boolean;
}

const state: {
  chain: ChainMock;
  mark: string | null;
  bid: string | null;
  ask: string | null;
  source: 'publisher' | 'chain';
  loading: boolean;
} = {
  chain: {
    priceImpactK: 10n ** 19n,
    netVolThreshold: 100_000n * E18,
    decayRate: 0n,
    buyVolume: 0n,
    sellVolume: 0n,
    lastUpdateTimestamp: 1_000_000,
    failed: false,
    transportFailed: false,
  },
  mark: '100000.000000000000000000',
  // Zero-width quote by default so the dynamic-curve assertions below isolate the dynamic
  // component; the spread term gets its own test.
  bid: '100000.000000000000000000',
  ask: '100000.000000000000000000',
  source: 'publisher',
  loading: false,
};

vi.mock('wagmi', () => ({
  useReadContracts: () => {
    const c = state.chain;
    if (c.transportFailed) {
      return { data: undefined, error: new Error('HTTP request failed. Status: 429'), isLoading: state.loading };
    }
    if (c.failed) {
      const failure = { status: 'failure' as const, error: new Error('execution reverted'), result: undefined };
      return { data: [failure, failure, failure], isLoading: state.loading };
    }
    return {
      isLoading: state.loading,
      data: [
        { status: 'success' as const, result: c.priceImpactK },
        { status: 'success' as const, result: [c.netVolThreshold, c.decayRate, c.priceImpactK] },
        { status: 'success' as const, result: [c.buyVolume, c.sellVolume, c.lastUpdateTimestamp] },
      ],
    };
  },
  useBlock: () => ({ data: { timestamp: 1_000_000n }, isLoading: state.loading }),
}));

vi.mock('@/hooks/usePrice', () => ({
  usePrice: () => ({
    data:
      state.mark === null
        ? null
        : {
            index: state.mark,
            mark: state.mark,
            bid: state.bid,
            ask: state.ask,
            updatedAt: 0,
            healthyVenues: ['bybit', 'okx', 'binance'],
            degraded: false,
            source: state.source,
          },
    error: null,
    loading: state.loading,
    refetch: vi.fn(),
  }),
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
        openInterest: { long: '5135.000000', short: '117.000000' },
      },
    ],
    loading: false,
    error: null,
  }),
}));

beforeEach(() => {
  state.chain = {
    priceImpactK: 10n ** 19n,
    netVolThreshold: 100_000n * E18,
    decayRate: 0n,
    buyVolume: 0n,
    sellVolume: 0n,
    lastUpdateTimestamp: 1_000_000,
    failed: false,
    transportFailed: false,
  };
  state.mark = '100000.000000000000000000';
  state.bid = '100000.000000000000000000';
  state.ask = '100000.000000000000000000';
  state.source = 'publisher';
  state.loading = false;
});

function rowTexts(side: 'long' | 'short') {
  return screen
    .getAllByTestId('depth-panel-row')
    .filter((el) => el.dataset.side === side)
    .map((el) => Array.from(el.children).map((c) => c.textContent));
}

describe('DepthPanel — live ladder', () => {
  it('renders both sides around the mark, worst fill furthest from it', () => {
    render(<DepthPanel />);

    expect(screen.getByTestId('depth-panel-ladder')).toBeInTheDocument();
    expect(within(screen.getByTestId('depth-panel-mid')).getByText('100,000.00')).toBeInTheDocument();

    // K = 1e19, threshold = 100,000 USD, no accumulated volume. Under the threshold the
    // curve is flat; the 250,000 and 1,000,000 rungs cross it.
    // Sign is "worse for your side": a long filled above the mark and a short filled below
    // it are both adverse, hence both '+'.
    expect(rowTexts('long')).toEqual([
      ['100,405.00', '1,000,000', '+40.500'],
      ['100,045.00', '250,000', '+4.500'],
      ['100,000.00', '100,000', '0.000'],
      ['100,000.00', '25,000', '0.000'],
      ['100,000.00', '5,000', '0.000'],
      ['100,000.00', '1,000', '0.000'],
    ]);
    expect(rowTexts('short')).toEqual([
      ['100,000.00', '1,000', '0.000'],
      ['100,000.00', '5,000', '0.000'],
      ['100,000.00', '25,000', '0.000'],
      ['100,000.00', '100,000', '0.000'],
      ['99,955.00', '250,000', '+4.500'],
      ['99,595.00', '1,000,000', '+40.500'],
    ]);
  });

  it('says on screen that these are the trader’s own prices, not resting orders', () => {
    render(<DepthPanel />);
    expect(screen.getByTestId('depth-panel')).toHaveTextContent(/no resting orders exist here/i);
    expect(screen.getByTestId('depth-panel')).toHaveTextContent(/your own.*execution prices by size against the vault/i);
  });

  it('adds the real oracle spread term on top of the dynamic component', () => {
    // ask 100,050 / bid 99,950 around a 100,000 mark:
    //   spreadComponent = 100e18 * 1e18 * 100 / (100,000e18 * 2) = 5e16   (0.050%)
    //   dynamic at 1M    = 4.05e17                                        (0.405%)
    //   total            = 4.55e17                                        (0.455%)
    // long fill = 100,000 * 1.00455 = 100,455.00 ; short fill = 99,545.00
    state.ask = '100050.000000000000000000';
    state.bid = '99950.000000000000000000';
    render(<DepthPanel />);

    expect(rowTexts('long')[0]).toEqual(['100,455.00', '1,000,000', '+45.500']);
    expect(rowTexts('short')[5]).toEqual(['99,545.00', '1,000,000', '+45.500']);
    // The mockup's mid readout, now a real number: 100,050 - 99,950 = 100.00
    expect(screen.getByTestId('depth-panel-mid')).toHaveTextContent('spread 100.00');
  });

  it('has no spread caveat any more — the quote is real', () => {
    render(<DepthPanel />);
    expect(screen.queryByTestId('depth-panel-caveat')).not.toBeInTheDocument();
    expect(screen.getByTestId('depth-panel-legend')).toHaveTextContent(/worse for your side/i);
  });

  it('moves with the mark price', () => {
    const { rerender } = render(<DepthPanel />);
    expect(rowTexts('long')[0]).toEqual(['100,405.00', '1,000,000', '+40.500']);

    state.mark = '200000.000000000000000000';
    rerender(<DepthPanel />);
    // Same 0.405% impact, applied to a doubled mark: 200,000 * 1.00405 = 200,810.
    expect(rowTexts('long')[0]).toEqual(['200,810.00', '1,000,000', '+40.500']);
  });

  it('shows accumulated buy volume pushing the long side further out than the short side', () => {
    state.chain.buyVolume = 500_000n * E18;
    render(<DepthPanel />);
    // Long: linear branch, 1e19*(5e23-1e23+5e23)*100/1e27 = 9e17 = 0.900% -> 100,900.
    expect(rowTexts('long')[0]).toEqual(['100,900.00', '1,000,000', '+90.000']);
    // Short reads sellVolume, which is still 0 -> the untouched 0.405%.
    expect(rowTexts('short')[5]).toEqual(['99,595.00', '1,000,000', '+40.500']);
  });
});

describe('DepthPanel — static spread path (priceImpactK == 0, this deployment)', () => {
  beforeEach(() => {
    state.chain.priceImpactK = 0n;
    state.ask = '100050.000000000000000000';
    state.bid = '99950.000000000000000000';
  });

  it('renders a WORKING ladder, not an unavailable state', () => {
    render(<DepthPanel />);
    expect(screen.getByTestId('depth-panel-ladder')).toBeInTheDocument();
    expect(screen.queryByTestId('depth-panel-unavailable')).not.toBeInTheDocument();
  });

  it('quotes every long at the ask and every short at the bid, flat across size', () => {
    render(<DepthPanel />);
    // |100,000 - 100,050| * 1e18 * 100 / 100,000e18 = 5e16 -> 0.050%, at every size.
    expect(rowTexts('long')).toEqual([
      ['100,050.00', '1,000,000', '+5.000'],
      ['100,050.00', '250,000', '+5.000'],
      ['100,050.00', '100,000', '+5.000'],
      ['100,050.00', '25,000', '+5.000'],
      ['100,050.00', '5,000', '+5.000'],
      ['100,050.00', '1,000', '+5.000'],
    ]);
    expect(rowTexts('short').map((r) => r[0])).toEqual(Array(6).fill('99,950.00'));
  });

  it('says why the levels are flat instead of leaving it looking broken', () => {
    render(<DepthPanel />);
    expect(screen.getByTestId('depth-panel-static-note')).toHaveTextContent(/flat across size by design/i);
    expect(screen.getByTestId('depth-panel-static-note')).toHaveTextContent(/priceImpactK = 0/);
  });

  it('signs a favourable fill negative when the mark sits outside the quote', () => {
    // The live shape: the EMA mark can drift below the whole index quote. A long then fills
    // 150 above it (adverse) while a short fills 50 above it — which is GOOD for a short.
    state.mark = '99900.000000000000000000';
    render(<DepthPanel />);
    // |99,900 - 100,050| * 1e18 * 100 / 99,900e18 = 150150150150150150 -> 0.15015015%
    //   -> 15.015 bps. The short's 50/99,900 is 50050050050050050 -> 5.005 bps, negative
    //   because filling a short ABOVE the mark is in the trader's favour.
    expect(rowTexts('long')[0]).toEqual(['100,050.00', '1,000,000', '+15.015']);
    expect(rowTexts('short')[0]).toEqual(['99,950.00', '1,000', '−5.005']);
  });

  it('ignores accumulated volume entirely — the dynamic branch is never entered', () => {
    state.chain.buyVolume = 500_000n * E18;
    render(<DepthPanel />);
    expect(rowTexts('long')[0]).toEqual(['100,050.00', '1,000,000', '+5.000']);
  });
});

describe('DepthPanel — honest unavailable states', () => {
  it('refuses to draw a ladder when the oracle publishes no two-sided quote', () => {
    state.ask = null;
    render(<DepthPanel />);

    expect(screen.queryByTestId('depth-panel-ladder')).not.toBeInTheDocument();
    const reason = screen.getByTestId('depth-panel-reason-no-quote');
    expect(reason).toHaveTextContent(/published no ask/i);
    // The mark must never be substituted for the missing side.
    expect(reason).toHaveTextContent(/no fill price to quote/i);
    expect(screen.getByTestId('depth-panel-readout')).toHaveTextContent('0xF872…4ED1');
  });

  it('explains the chain fallback, which carries one price and no quote', () => {
    state.bid = null;
    state.ask = null;
    state.source = 'chain';
    render(<DepthPanel />);
    expect(screen.getByTestId('depth-panel-reason-no-quote')).toHaveTextContent(
      /last settled on-chain report/i,
    );
  });

  it('refuses a crossed quote rather than pricing a fill against it', () => {
    state.bid = '100010.000000000000000000';
    state.ask = '100000.000000000000000000';
    render(<DepthPanel />);
    expect(screen.getByTestId('depth-panel-reason-no-quote')).toHaveTextContent(/crossed quote/i);
  });

  it('reports a reverted read instead of falling back to invented depth', () => {
    state.chain.failed = true;
    render(<DepthPanel />);

    expect(screen.queryByTestId('depth-panel-ladder')).not.toBeInTheDocument();
    expect(screen.getByTestId('depth-panel-reason-read-failed')).toHaveTextContent(/execution reverted/);
  });

  it('names the reason when the RPC itself fails, rather than an empty notice', () => {
    state.chain.transportFailed = true;
    render(<DepthPanel />);

    expect(screen.queryByTestId('depth-panel-ladder')).not.toBeInTheDocument();
    const reason = screen.getByTestId('depth-panel-reason-read-failed');
    expect(reason).toHaveTextContent(/Status: 429/);
    // The regression this guards: a transport error sets `error` and leaves `data`
    // undefined, so a check that only looked at `data[i].status` produced a notice with no
    // reasons under it at all.
    expect(reason.textContent?.trim().length ?? 0).toBeGreaterThan(20);
  });

  it('reports a missing mark price', () => {
    state.mark = null;
    render(<DepthPanel />);

    expect(screen.queryByTestId('depth-panel-ladder')).not.toBeInTheDocument();
    expect(screen.getByTestId('depth-panel-reason-no-price')).toHaveTextContent(/no mark price published/i);
  });

  it('shows a loading state rather than an empty ladder while reads are in flight', () => {
    state.loading = true;
    render(<DepthPanel />);
    expect(screen.getByTestId('depth-panel-loading')).toBeInTheDocument();
    expect(screen.queryByTestId('depth-panel-ladder')).not.toBeInTheDocument();
  });
});
