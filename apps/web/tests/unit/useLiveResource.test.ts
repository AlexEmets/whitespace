import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/ws', () => ({ getWsClient: () => ({ subscribe: () => () => {} }) }));

import { useLiveResource } from '@/hooks/useLiveResource';

const never = () => null;

beforeEach(() => vi.useFakeTimers({ shouldAdvanceTime: true }));
afterEach(() => vi.useRealTimers());

describe('useLiveResource', () => {
  it('keeps the last good data when a later poll fails, flagged stale rather than errored', async () => {
    let fail = false;
    const fetcher = vi.fn(async () => {
      if (fail) throw new Error('api down');
      return ['position'];
    });
    const { result } = renderHook(() => useLiveResource({ channel: 'positions:a', fetcher, extractFromWs: never, pollMs: 1000 }));
    await waitFor(() => expect(result.current.data).toEqual(['position']));

    fail = true;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    await waitFor(() => expect(result.current.stale).toBe(true));
    expect(result.current.data).toEqual(['position']);
    expect(result.current.error).toBeNull();

    fail = false;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    await waitFor(() => expect(result.current.stale).toBe(false));
  });

  it('reports the error when there is nothing to show', async () => {
    const fetcher = vi.fn(async () => {
      throw new Error('api down');
    });
    const { result } = renderHook(() => useLiveResource({ channel: 'positions:a', fetcher, extractFromWs: never }));
    await waitFor(() => expect(result.current.error?.message).toBe('api down'));
    expect(result.current.stale).toBe(false);
  });

  it('drops a response for the previous channel that resolves after a switch', async () => {
    let resolveOld: (v: string[]) => void = () => {};
    const fetchers: Record<string, () => Promise<string[]>> = {
      a: () => new Promise((r) => (resolveOld = r)),
      b: async () => ['b-position'],
    };
    const { result, rerender } = renderHook(({ ch }) =>
      useLiveResource({ channel: `positions:${ch}`, fetcher: fetchers[ch]!, extractFromWs: never, pollMs: 60_000 }),
      { initialProps: { ch: 'a' } },
    );
    rerender({ ch: 'b' });
    await waitFor(() => expect(result.current.data).toEqual(['b-position']));

    await act(async () => resolveOld(['a-position']));
    expect(result.current.data).toEqual(['b-position']);
  });

  it('does not show the previous channel’s data while the new one loads', async () => {
    const fetchers: Record<string, () => Promise<string[]>> = {
      a: async () => ['a-position'],
      b: () => new Promise(() => {}),
    };
    const { result, rerender } = renderHook(({ ch }) =>
      useLiveResource({ channel: `positions:${ch}`, fetcher: fetchers[ch]!, extractFromWs: never }),
      { initialProps: { ch: 'a' } },
    );
    await waitFor(() => expect(result.current.data).toEqual(['a-position']));
    rerender({ ch: 'b' });
    await waitFor(() => expect(result.current.data).toBeNull());
  });
});
