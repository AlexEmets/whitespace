import { act, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LiveNumber, valueAt } from '@/components/points/LiveNumber';

const START = 1_800_000_000_000; // a whole second, in ms

describe('valueAt', () => {
  it('moves from the value a second ago to the value now across the second', () => {
    expect(valueAt(1_000_000n, 2_000_000n, START, START)).toBe(1_000_000n);
    expect(valueAt(1_000_000n, 2_000_000n, START, START + 250)).toBe(1_250_000n);
    expect(valueAt(1_000_000n, 2_000_000n, START, START + 1000)).toBe(2_000_000n);
  });

  it('holds at the ends rather than running past either', () => {
    expect(valueAt(1_000_000n, 2_000_000n, START, START - 500)).toBe(1_000_000n);
    expect(valueAt(1_000_000n, 2_000_000n, START, START + 5000)).toBe(2_000_000n);
  });
});

describe('<LiveNumber>', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date', 'requestAnimationFrame', 'cancelAnimationFrame', 'setTimeout'] });
    vi.setSystemTime(START);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('splits the figure so the fraction can be styled apart', () => {
    const { container } = render(<LiveNumber from={1_234_567n} to={1_234_567n} startMs={START} dp={3} fracClassName="f" />);
    expect(container.textContent).toBe('1.235'); // rounded, as every figure on the page is
    expect(container.querySelector('.f')!.textContent).toBe('.235');
  });

  it('glides through the second on its own, with no new props', () => {
    const { container } = render(<LiveNumber from={0n} to={1_000_000n} startMs={START} dp={6} />);
    expect(container.textContent).toBe('0.000000');
    // Halfway, as of the last frame drawn before 500 ms.
    act(() => {
      vi.advanceTimersByTime(500);
    });
    expect(Number(container.textContent)).toBeGreaterThan(0.45);
    expect(Number(container.textContent)).toBeLessThanOrEqual(0.5);
    act(() => {
      vi.advanceTimersByTime(700);
    });
    expect(container.textContent).toBe('1.000000');
  });

  it('stops asking for frames once the second is over', () => {
    const raf = vi.spyOn(window, 'requestAnimationFrame');
    render(<LiveNumber from={0n} to={1_000_000n} startMs={START} dp={6} />);
    act(() => {
      vi.advanceTimersByTime(1100);
    });
    const calls = raf.mock.calls.length;
    expect(calls).toBeGreaterThan(1);
    act(() => {
      vi.advanceTimersByTime(500);
    });
    expect(raf.mock.calls.length).toBe(calls);
  });

  it('does not animate a counter that is not moving', () => {
    const raf = vi.spyOn(window, 'requestAnimationFrame');
    render(<LiveNumber from={5_000_000n} to={5_000_000n} startMs={START} dp={2} />);
    expect(raf).not.toHaveBeenCalled();
  });

  it('jumps once a second instead of gliding when the reader asks for less motion', () => {
    vi.stubGlobal('matchMedia', (q: string) => ({ matches: q.includes('reduce') }));
    const { container } = render(<LiveNumber from={0n} to={1_000_000n} startMs={START} dp={6} />);
    act(() => {
      vi.advanceTimersByTime(500);
    });
    expect(container.textContent).toBe('0.000000');
  });

  it('shows the new figure when the next second’s props arrive', () => {
    const { container, rerender } = render(<LiveNumber from={0n} to={1_000_000n} startMs={START} dp={6} />);
    vi.setSystemTime(START + 1000);
    rerender(<LiveNumber from={1_000_000n} to={2_000_000n} startMs={START + 1000} dp={6} />);
    expect(container.textContent).toBe('1.000000');
  });
});
