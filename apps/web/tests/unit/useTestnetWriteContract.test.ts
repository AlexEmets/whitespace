import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CHAIN_ID, CHAIN_INFO } from '@/lib/config';

/**
 * A wallet browser sitting on Ethereum mainnet offered to sign the USDW claim on mainnet:
 * wagmi's writeContract with no chainId sends wherever the wallet is. These pin down the
 * guard every write now goes through — switch first, then sign with the chain named.
 */

const state = vi.hoisted(() => ({
  chainId: undefined as number | undefined,
  calls: [] as string[],
  switchChainAsync: vi.fn(),
  writeContractAsync: vi.fn(),
}));

vi.mock('wagmi', () => ({
  useAccount: () => ({ chainId: state.chainId }),
  useSwitchChain: () => ({ switchChainAsync: state.switchChainAsync }),
  useWriteContract: () => ({ writeContractAsync: state.writeContractAsync, isPending: true }),
}));

import { TESTNET_SWITCH, useEnsureTestnet, useTestnetWriteContract } from '@/hooks/useTestnetWriteContract';

const REQUEST = {
  address: '0x1111111111111111111111111111111111111111',
  abi: [],
  functionName: 'claim',
  args: [],
} as never;

beforeEach(() => {
  state.calls.length = 0;
  state.switchChainAsync.mockReset().mockImplementation(async () => {
    state.calls.push('switch');
  });
  state.writeContractAsync.mockReset().mockImplementation(async () => {
    state.calls.push('write');
    return '0xhash';
  });
});

describe('useTestnetWriteContract', () => {
  it('signs straight away on 1874, with the chain named so viem checks it', async () => {
    state.chainId = CHAIN_ID;
    const { result } = renderHook(() => useTestnetWriteContract());

    await act(async () => {
      await result.current.writeContractAsync(REQUEST);
    });

    expect(state.switchChainAsync).not.toHaveBeenCalled();
    expect(state.writeContractAsync).toHaveBeenCalledWith(
      expect.objectContaining({ functionName: 'claim', chainId: CHAIN_ID }),
    );
  });

  it('switches a wallet on another network to 1874 before it signs', async () => {
    state.chainId = 1; // Ethereum mainnet
    const { result } = renderHook(() => useTestnetWriteContract());

    await act(async () => {
      await result.current.writeContractAsync(REQUEST);
    });

    expect(state.switchChainAsync).toHaveBeenCalledWith(TESTNET_SWITCH);
    expect(state.calls).toEqual(['switch', 'write']);
    expect(state.writeContractAsync).toHaveBeenCalledWith(expect.objectContaining({ chainId: CHAIN_ID }));
  });

  it('signs nothing when the trader declines the switch', async () => {
    state.chainId = 1;
    state.switchChainAsync.mockRejectedValueOnce(new Error('User rejected the request.'));
    const { result } = renderHook(() => useTestnetWriteContract());

    await expect(result.current.writeContractAsync(REQUEST)).rejects.toThrow('User rejected');
    expect(state.writeContractAsync).not.toHaveBeenCalled();
  });

  /** Claim then approve: two signatures in one flow, before the next render. */
  it('does not ask to switch again for the next signature in the same flow', async () => {
    state.chainId = 1;
    const { result } = renderHook(() => useTestnetWriteContract());

    await act(async () => {
      await result.current.writeContractAsync(REQUEST);
      await result.current.writeContractAsync(REQUEST);
    });

    expect(state.switchChainAsync).toHaveBeenCalledTimes(1);
    expect(state.writeContractAsync).toHaveBeenCalledTimes(2);
  });

  it('passes wagmi’s options through, and only when given', async () => {
    state.chainId = CHAIN_ID;
    const { result } = renderHook(() => useTestnetWriteContract());
    const options = { onSuccess: vi.fn() };

    await act(async () => {
      await result.current.writeContractAsync(REQUEST);
      await result.current.writeContractAsync(REQUEST, options as never);
    });

    expect(state.writeContractAsync.mock.calls[0]).toHaveLength(1);
    expect(state.writeContractAsync.mock.calls[1]?.[1]).toBe(options);
  });

  it('reports wagmi’s pending state unchanged', () => {
    const { result } = renderHook(() => useTestnetWriteContract());
    expect(result.current.isPending).toBe(true);
  });
});

describe('useEnsureTestnet', () => {
  it('resolves without asking when the wallet is already on 1874', async () => {
    state.chainId = CHAIN_ID;
    const { result } = renderHook(() => useEnsureTestnet());
    await act(async () => {
      await result.current();
    });
    expect(state.switchChainAsync).not.toHaveBeenCalled();
  });
});

describe('TESTNET_SWITCH', () => {
  /** The wallet keeps this network entry long after the tab is gone; the app's own RPC
   * cache is not something to hand it. */
  it('offers a wallet that lacks 1874 the public RPC and the explorer', () => {
    expect(TESTNET_SWITCH.chainId).toBe(CHAIN_ID);
    expect(TESTNET_SWITCH.addEthereumChainParameter.rpcUrls).toEqual([CHAIN_INFO.rpc]);
    expect(TESTNET_SWITCH.addEthereumChainParameter.blockExplorerUrls).toEqual(['https://explorer.testnet.whitechain.io']);
    expect(TESTNET_SWITCH.addEthereumChainParameter.nativeCurrency.symbol).toBe('WBT');
  });
});
