import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { PnlSparkline, sparklineGeometry } from '@/components/portfolio/PnlSparkline';

describe('sparklineGeometry', () => {
  it('steps: flat until a close, then straight to the new total', () => {
    const g = sparklineGeometry([0, 1, -1], 100, 20, 0)!;
    expect(g.line).toBe('M0 10 H50 V0 H100 V20');
    expect(g.zeroY).toBe(10);
  });

  it('closes the fill down to the zero line, not the bottom of the box', () => {
    const g = sparklineGeometry([0, 1, -1], 100, 20, 0)!;
    expect(g.area).toBe('M0 10 H50 V0 H100 V20 V10 H0 Z');
  });

  it('keeps zero on the chart when every total is above it', () => {
    const g = sparklineGeometry([1, 2], 100, 20, 0)!;
    expect(g.zeroY).toBe(20);
    expect(g.line).toBe('M0 10 H100 V0');
  });

  it('draws a flat line at zero without dividing by zero', () => {
    const g = sparklineGeometry([0, 0], 100, 20, 2)!;
    expect(g.line).toBe('M2 2 H98 V2');
    expect(g.line).not.toContain('NaN');
  });

  it('has nothing to draw with fewer than two points', () => {
    expect(sparklineGeometry([], 100, 20)).toBeNull();
    expect(sparklineGeometry([0], 100, 20)).toBeNull();
  });
});

describe('<PnlSparkline>', () => {
  it('names what it shows for a screen reader', () => {
    render(<PnlSparkline values={[0, -0.05, 0.23, 0.59]} />);
    expect(screen.getByTestId('pnl-sparkline')).toHaveAttribute(
      'aria-label',
      'Realised PnL over 3 closes, ending at 0.59 USDW',
    );
  });

  it('renders nothing before the first close', () => {
    const { container } = render(<PnlSparkline values={[]} />);
    expect(container).toBeEmptyDOMElement();
  });
});
