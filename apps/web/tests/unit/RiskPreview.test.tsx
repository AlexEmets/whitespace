import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { RiskPreview, riskMarkers } from '@/components/RiskPreview';

const E18 = 10n ** 18n;
const p = (n: number) => BigInt(n) * E18;

describe('riskMarkers', () => {
  it('orders a long from liquidation up to take-profit, placed by price', () => {
    const markers = riskMarkers({ liq: p(75_000), sl: p(80_000), entry: p(83_000), tp: p(87_000) });
    expect(markers.map((m) => m.key)).toEqual(['liq', 'sl', 'entry', 'tp']);
    expect(markers[0]!.pct).toBe(0);
    expect(markers[3]!.pct).toBe(100);
    expect(markers[2]!.pct).toBeCloseTo(66.67, 1);
  });

  it('orders a short with liquidation on top', () => {
    const markers = riskMarkers({ liq: p(91_000), sl: p(86_000), entry: p(83_000), tp: p(79_000) });
    expect(markers.map((m) => m.key)).toEqual(['tp', 'entry', 'sl', 'liq']);
  });

  it('leaves out a TP or SL that is not set, instead of drawing it at zero', () => {
    const markers = riskMarkers({ liq: p(75_000), sl: 0n, entry: p(83_000), tp: null });
    expect(markers.map((m) => m.key)).toEqual(['liq', 'entry']);
    expect(markers.map((m) => m.pct)).toEqual([0, 100]);
  });

  it('centres a lone level', () => {
    expect(riskMarkers({ entry: p(83_000) })).toEqual([{ key: 'entry', label: 'Entry', value: p(83_000), pct: 50 }]);
  });
});

describe('<RiskPreview>', () => {
  it('labels each level with its price', () => {
    render(<RiskPreview entry={p(83_031)} liq={p(75_558)} tp={p(87_000)} sl={0n} />);
    const preview = screen.getByTestId('risk-preview');
    expect(preview).toHaveTextContent('Liq.75,558');
    expect(preview).toHaveTextContent('Entry83,031');
    expect(preview).toHaveTextContent('TP87,000');
    expect(screen.queryByTestId('risk-sl')).not.toBeInTheDocument();
  });

  it('renders nothing until there is an entry and a liquidation price', () => {
    const { container, rerender } = render(<RiskPreview entry={0n} liq={p(75_000)} tp={null} sl={null} />);
    expect(container).toBeEmptyDOMElement();
    rerender(<RiskPreview entry={p(83_000)} liq={null} tp={null} sl={null} />);
    expect(container).toBeEmptyDOMElement();
  });
});
