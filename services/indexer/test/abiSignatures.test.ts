// Every event fragment this indexer subscribes to must hash to the same topic0 as the
// Solidity declaration it was transcribed from — a one-character slip in a hand-written
// fragment silently indexes nothing. The canonical signatures below are copied from
// contracts/src/vendor/ostium/interfaces (enums are uint8, structs are tuples).
import { describe, it, expect } from 'vitest';
import { toEventSelector, type AbiEvent } from 'viem';
import { tradingAbi } from '../abis/trading.js';
import { tradingCallbacksAbi } from '../abis/tradingCallbacks.js';
import { vaultAbi } from '../abis/vault.js';

const TRADE = '(uint256,uint192,uint192,uint192,address,uint32,uint16,uint8,bool,bool)';

const CANONICAL: Record<string, string> = {
  OpenLimitPlacedV2: `OpenLimitPlacedV2(address,uint16,uint8,${TRADE},uint8,(address,uint32))`,
  OpenLimitUpdated: 'OpenLimitUpdated(address,uint16,uint8,uint192,uint192,uint192)',
  OpenLimitCanceled: 'OpenLimitCanceled(address,uint16,uint8)',
  OracleFeeChargedLimitCancelled: 'OracleFeeChargedLimitCancelled(address,uint16,uint256)',
  DevFeeCharged: 'DevFeeCharged(uint256,address,uint256)',
  OracleFeeCharged: 'OracleFeeCharged(uint256,address,uint256)',
  VaultOpeningFeeCharged: 'VaultOpeningFeeCharged(uint256,address,uint256)',
  VaultLiqFeeCharged: 'VaultLiqFeeCharged(uint256,uint256,address,uint256)',
  FeesChargedV2: 'FeesChargedV2(uint256,uint256,address,int256,int256)',
  OracleFeeBondCharged: 'OracleFeeBondCharged(uint256,address,uint256,uint32,uint192,uint192)',
  // Emitted by the CALLBACKS (handleRemoveCollateral) with a CancelReason enum. IOstiumTrading
  // declares a same-named event with (tradeId, orderId, ..., string reason) that Trading never
  // emits, so subscribing to that one resolves nothing.
  RemoveCollateralRejected: 'RemoveCollateralRejected(uint256,uint256,address,uint16,uint256,uint8)',
  SettlementExecuted:
    'SettlementExecuted(uint32,uint32,int256,uint8,int256,uint256,uint256,int256,uint256,uint256,int256)',
  AsyncDepositWithdrawExecuted: 'AsyncDepositWithdrawExecuted(uint32,int256,uint256,uint256,uint256)',
};

function eventOf(abi: readonly unknown[], name: string): AbiEvent {
  const found = (abi as AbiEvent[]).find((e) => e.type === 'event' && e.name === name);
  if (!found) throw new Error(`no event ${name} in abi`);
  return found;
}

describe('ABI fragments match the Solidity event signatures', () => {
  const abis = [tradingAbi, tradingCallbacksAbi, vaultAbi] as const;
  for (const [name, signature] of Object.entries(CANONICAL)) {
    it(name, () => {
      const abi = abis.find((a) => (a as readonly { name?: string }[]).some((e) => e.name === name));
      expect(abi, `${name} missing from every abi`).toBeDefined();
      expect(toEventSelector(eventOf(abi!, name))).toBe(toEventSelector(signature));
    });
  }
});

export { CANONICAL };
