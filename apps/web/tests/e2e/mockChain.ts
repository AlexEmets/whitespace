import {
  decodeFunctionData,
  encodeAbiParameters,
  encodeEventTopics,
  parseAbiParameters,
  encodeFunctionResult,
  numberToHex,
  type Address,
  type Hex,
} from 'viem';
import { CHAIN_ID } from '../../src/lib/config';
import {
  CALLBACKS_ADDRESS,
  COLLATERAL_ADDRESS,
  PAIRS_STORAGE_ADDRESS,
  PAIR_INFOS_ADDRESS,
  TRADING_ADDRESS,
  TRADING_STORAGE_ADDRESS,
  VAULT_ADDRESS,
} from '../../src/lib/deployment';
import {
  CALLBACKS_ABI,
  ERC20_ABI,
  PAIRS_STORAGE_ABI,
  PAIR_INFOS_ABI,
  TRADING_ABI,
  TRADING_STORAGE_ABI,
  VAULT_ABI,
} from '../../src/lib/abi';
import { PAIR_INFOS_IMPACT_ABI } from '../../src/lib/abiPairInfos';
import { MOCK_TRADER_ADDRESS, type TestState } from './testState';

const CHAIN_ID_HEX = numberToHex(CHAIN_ID);
let receiptCounter = 0;
let blockCounter = 10;

/**
 * A call the mock does not model. It is answered as an `execution reverted` JSON-RPC error —
 * what a real node returns for a selector the contract lacks — instead of throwing inside the
 * route handler, which used to tear down the whole page session and fail unrelated tests.
 */
export class UnmockedCallError extends Error {
  constructor(to: string, data: string) {
    super(`execution reverted: unmocked eth_call ${data.slice(0, 10)} on ${to}`);
    this.name = 'UnmockedCallError';
  }
}

const PAIR_INFOS_READ_ABI = [...PAIR_INFOS_ABI, ...PAIR_INFOS_IMPACT_ABI];

interface EthRequestPayload {
  method: string;
  params?: unknown[];
}

/**
 * Answers the subset of the EIP-1193 JSON-RPC surface this app's wallet-signed writes
 * and balance/allowance/vault-status reads need. Bridged into the browser as
 * `window.ethereum.request` via `page.exposeFunction` + `page.addInitScript` (see
 * trade-flow.spec.ts) — real ABI decoding/encoding happens here in Node, using the exact
 * same ABIs (src/lib/abi.ts) and addresses (src/lib/deployment.ts) the app itself uses,
 * so this mock cannot silently drift from what the app actually calls.
 */
export function createMockChain(state: TestState) {
  const receipts = new Map<string, unknown>();

  function addressEquals(a: string, b: Address): boolean {
    return a.toLowerCase() === b.toLowerCase();
  }

  function handleCall(callParams: { to?: string; data?: Hex }): Hex {
    const { to, data } = callParams;
    if (!to || !data) return '0x';

    if (addressEquals(to, COLLATERAL_ADDRESS)) {
      const decoded = decodeFunctionData({ abi: ERC20_ABI, data });
      if (decoded.functionName === 'balanceOf') {
        return encodeFunctionResult({ abi: ERC20_ABI, functionName: 'balanceOf', result: state.usdwBalance });
      }
      if (decoded.functionName === 'allowance') {
        const [, spender] = decoded.args as [Address, Address];
        const amount = state.allowances.get(spender.toLowerCase()) ?? 0n;
        return encodeFunctionResult({ abi: ERC20_ABI, functionName: 'allowance', result: amount });
      }
      if (decoded.functionName === 'decimals') {
        return encodeFunctionResult({ abi: ERC20_ABI, functionName: 'decimals', result: 6 });
      }
    }

    if (addressEquals(to, VAULT_ADDRESS)) {
      const decoded = decodeFunctionData({ abi: VAULT_ABI, data });
      if (decoded.functionName === 'targetSettlementId') {
        return encodeFunctionResult({
          abi: VAULT_ABI,
          functionName: 'targetSettlementId',
          result: state.vaultSettlementId,
        });
      }
      if (decoded.functionName === 'getDepositStatus') {
        const [, settlementId] = decoded.args as [Address, number];
        const status = state.depositStatus.get(settlementId) ?? 0;
        return encodeFunctionResult({ abi: VAULT_ABI, functionName: 'getDepositStatus', result: status });
      }
      if (decoded.functionName === 'getWithdrawStatus') {
        return encodeFunctionResult({ abi: VAULT_ABI, functionName: 'getWithdrawStatus', result: 0 });
      }
      if (decoded.functionName === 'currentBalance' || decoded.functionName === 'tvl') {
        return encodeFunctionResult({ abi: VAULT_ABI, functionName: decoded.functionName, result: 100_000_000_000n });
      }
    }

    if (addressEquals(to, TRADING_ADDRESS)) {
      const decoded = decodeFunctionData({ abi: TRADING_ABI, data });
      if (decoded.functionName === 'marketOrdersTimeout') {
        return encodeFunctionResult({ abi: TRADING_ABI, functionName: 'marketOrdersTimeout', result: 11 });
      }
      if (decoded.functionName === 'triggerTimeout') {
        return encodeFunctionResult({ abi: TRADING_ABI, functionName: 'triggerTimeout', result: 30 });
      }
      if (decoded.functionName === 'delegations') {
        // No one-click session key registered by default, so the offer shows its "Off" state.
        return encodeFunctionResult({
          abi: TRADING_ABI,
          functionName: 'delegations',
          result: '0x0000000000000000000000000000000000000000',
        });
      }
    }

    if (addressEquals(to, CALLBACKS_ADDRESS)) {
      decodeFunctionData({ abi: CALLBACKS_ABI, data }); // maxSl_P is the only read
      return encodeFunctionResult({ abi: CALLBACKS_ABI, functionName: 'maxSl_P', result: 75 });
    }

    if (addressEquals(to, TRADING_STORAGE_ADDRESS)) {
      const decoded = decodeFunctionData({ abi: TRADING_STORAGE_ABI, data });
      const [, pairIndex, index] = decoded.args as [Address, number, number];
      const p = state.positions.find((x) => x.pairIndex === pairIndex && x.index === index);
      return encodeFunctionResult({
        abi: TRADING_STORAGE_ABI,
        functionName: 'openTradesInfo',
        result: [BigInt(p?.tradeId ?? 0), 0n, Number(p?.leverage ?? 0), 0, 0, 0, false],
      });
    }

    if (addressEquals(to, PAIR_INFOS_ADDRESS)) {
      const decoded = decodeFunctionData({ abi: PAIR_INFOS_READ_ABI, data });
      if (decoded.functionName === 'getPairPriceImpactK') {
        return encodeFunctionResult({
          abi: PAIR_INFOS_IMPACT_ABI,
          functionName: 'getPairPriceImpactK',
          result: state.priceImpactK,
        });
      }
      if (decoded.functionName === 'pairDynamicSpreadParams') {
        return encodeFunctionResult({
          abi: PAIR_INFOS_IMPACT_ABI,
          functionName: 'pairDynamicSpreadParams',
          result: [0n, 0n, state.priceImpactK],
        });
      }
      if (decoded.functionName === 'pairDynamicSpreadState') {
        return encodeFunctionResult({
          abi: PAIR_INFOS_IMPACT_ABI,
          functionName: 'pairDynamicSpreadState',
          result: [0n, 0n, 0],
        });
      }
      if (decoded.functionName === 'getPendingAccFundingFees') {
        return encodeFunctionResult({
          abi: PAIR_INFOS_ABI,
          functionName: 'getPendingAccFundingFees',
          result: [0n, 0n, state.fundingRatePerBlock, 0n],
        });
      }
      if (decoded.functionName === 'getTradeFundingFee') {
        return encodeFunctionResult({ abi: PAIR_INFOS_ABI, functionName: 'getTradeFundingFee', result: [0n, 0n] });
      }
      if (decoded.functionName === 'getTradeRolloverFee') {
        return encodeFunctionResult({ abi: PAIR_INFOS_ABI, functionName: 'getTradeRolloverFee', result: 0n });
      }
      if (decoded.functionName === 'getTradeLiquidationPrice' || decoded.functionName === 'getTradeLiquidationPricePure') {
        return encodeFunctionResult({ abi: PAIR_INFOS_ABI, functionName: decoded.functionName, result: 58_500n * 10n ** 18n });
      }
      if (decoded.functionName === 'pairOpeningFees') {
        // Matches the ruling's stated real config: opening fees are currently zero.
        return encodeFunctionResult({
          abi: PAIR_INFOS_ABI,
          functionName: 'pairOpeningFees',
          result: [0, 0, 0, 0, 0, 0],
        });
      }
    }

    if (addressEquals(to, PAIRS_STORAGE_ADDRESS)) {
      const decoded = decodeFunctionData({ abi: PAIRS_STORAGE_ABI, data });
      if (decoded.functionName === 'pairOracleFee') {
        // 1_000000 = $1.00 flat oracle fee (PRECISION_6), per the ruling's stated config.
        return encodeFunctionResult({ abi: PAIRS_STORAGE_ABI, functionName: 'pairOracleFee', result: 1_000_000n });
      }
      if (decoded.functionName === 'pairMinLevPos') {
        // 1,500 USDW collateral x leverage (PRECISION_6): the close dialog's floor for
        // what a partial close must leave behind.
        return encodeFunctionResult({ abi: PAIRS_STORAGE_ABI, functionName: 'pairMinLevPos', result: 1_500_000000n });
      }
    }

    throw new UnmockedCallError(to, data);
  }

  /**
   * The app simulates every write (`simulateContract`) before asking the wallet to sign it.
   * A simulated write succeeds here with empty return data — the state change itself is
   * modelled in handleSendTransaction when the transaction is actually sent.
   */
  function isSimulatedWrite(data: Hex): boolean {
    for (const abi of [ERC20_ABI, VAULT_ABI, TRADING_ABI] as const) {
      // A read on TRADING_ABI (marketOrdersTimeout, triggerTimeout) is not a write.
      try {
        const { functionName } = decodeFunctionData({ abi, data });
        const item = (abi as readonly { type: string; name?: string; stateMutability?: string }[]).find(
          (i) => i.type === 'function' && i.name === functionName,
        );
        return item?.stateMutability === 'nonpayable' || item?.stateMutability === 'payable';
      } catch {
        // not this ABI — try the next
      }
    }
    return false;
  }

  /** Decodes with the app's own ABIs; a selector none of them know is also "unmocked". */
  function safeHandleCall(callParams: { to?: string; data?: Hex }): Hex {
    if (callParams.data && isSimulatedWrite(callParams.data)) return '0x';
    try {
      return handleCall(callParams);
    } catch (err) {
      if (err instanceof UnmockedCallError) throw err;
      throw new UnmockedCallError(callParams.to ?? '0x', callParams.data ?? '0x');
    }
  }

  function makeReceipt(hash: Hex, to: Address, logs: unknown[]) {
    const blockNumber = numberToHex(blockCounter);
    return {
      transactionHash: hash,
      transactionIndex: '0x0',
      blockHash: numberToHex(blockCounter + 1000),
      blockNumber,
      from: MOCK_TRADER_ADDRESS,
      to,
      cumulativeGasUsed: '0x5208',
      gasUsed: '0x5208',
      contractAddress: null,
      logs,
      logsBloom: `0x${'0'.repeat(512)}`,
      status: '0x1',
      type: '0x0',
    };
  }

  function handleSendTransaction(tx: { to?: string; data?: Hex }): Hex {
    receiptCounter += 1;
    blockCounter += 1;
    const hash = numberToHex(receiptCounter, { size: 32 });
    const to = tx.to as Address;
    const data = tx.data as Hex;

    if (addressEquals(to, COLLATERAL_ADDRESS)) {
      const decoded = decodeFunctionData({ abi: ERC20_ABI, data });
      if (decoded.functionName === 'approve') {
        const [spender, amount] = decoded.args as [Address, bigint];
        state.allowances.set(spender.toLowerCase(), amount);
      } else if (decoded.functionName === 'claim') {
        state.usdwBalance += 1_000_000_000n; // USDW.sol FAUCET_AMOUNT = 1_000e6
      }
      receipts.set(hash, makeReceipt(hash, to, []));
      return hash;
    }

    if (addressEquals(to, VAULT_ADDRESS)) {
      const decoded = decodeFunctionData({ abi: VAULT_ABI, data });
      if (decoded.functionName === 'requestDeposit') {
        const [assets] = decoded.args as [bigint];
        if (state.usdwBalance < assets) throw new Error('mock chain: insufficient USDW for requestDeposit');
        state.usdwBalance -= assets;
        state.depositStatus.set(state.vaultSettlementId, 1); // PENDING
      } else if (decoded.functionName === 'claimDeposit') {
        const [settlementId] = decoded.args as [number];
        if (state.depositStatus.get(settlementId) !== 2) {
          throw new Error('mock chain: claimDeposit called before settlement is CLAIMABLE');
        }
        state.depositStatus.set(settlementId, 0); // NONE (claimed)
        state.vaultShareBalance += 1n;
      }
      receipts.set(hash, makeReceipt(hash, to, []));
      return hash;
    }

    if (addressEquals(to, TRADING_ADDRESS)) {
      const decoded = decodeFunctionData({ abi: TRADING_ABI, data });
      let logs: unknown[] = [];
      state.sentTrading.push({ functionName: decoded.functionName, args: decoded.args ?? [] });
      const now = Math.floor(Date.now() / 1000);

      if (decoded.functionName === 'openTrade' && (decoded.args[2] as number) !== 0) {
        const [t, , orderType] = decoded.args;
        const index = state.limitOrders.filter((o) => o.pairIndex === t.pairIndex).length;
        state.limitOrders.push({
          pairIndex: t.pairIndex,
          index,
          orderType: orderType === 1 ? 'LIMIT' : 'STOP',
          buy: t.buy,
          collateral: t.collateral.toString(),
          leverage: t.leverage.toString(),
          triggerPrice: t.openPrice.toString(),
          tp: t.tp.toString(),
          sl: t.sl.toString(),
          placedAt: now,
          updatedAt: now,
        });
        const topics = encodeEventTopics({
          abi: TRADING_ABI,
          eventName: 'OpenLimitPlacedV2',
          args: { trader: t.trader, pairIndex: t.pairIndex },
        });
        logs = [
          {
            address: TRADING_ADDRESS,
            topics,
            data: encodeAbiParameters(
              parseAbiParameters(
                'uint8 index, (uint256,uint192,uint192,uint192,address,uint32,uint16,uint8,bool,bool) trade, uint8 orderType, (address,uint32) builderFee',
              ),
              [
                index,
                [t.collateral, t.openPrice, t.tp, t.sl, t.trader, t.leverage, t.pairIndex, index, t.buy, t.isDayTrade],
                orderType as number,
                ['0x0000000000000000000000000000000000000000', 0],
              ],
            ),
            blockHash: numberToHex(blockCounter + 1000),
            blockNumber: numberToHex(blockCounter),
            transactionHash: hash,
            transactionIndex: '0x0',
            logIndex: '0x0',
            removed: false,
          },
        ];
      } else if (decoded.functionName === 'cancelOpenLimitOrder') {
        const [pairIndex, index] = decoded.args;
        state.limitOrders = state.limitOrders.filter((o) => !(o.pairIndex === pairIndex && o.index === index));
      } else if (decoded.functionName === 'updateOpenLimitOrder') {
        const [pairIndex, index, price, tp, sl] = decoded.args;
        const o = state.limitOrders.find((x) => x.pairIndex === pairIndex && x.index === index);
        if (o) Object.assign(o, { triggerPrice: price.toString(), tp: tp.toString(), sl: sl.toString(), updatedAt: now });
      } else if (decoded.functionName === 'updateTp' || decoded.functionName === 'updateSl') {
        const [pairIndex, index, value] = decoded.args;
        const p = state.positions.find((x) => x.pairIndex === pairIndex && x.index === index);
        if (p) p[decoded.functionName === 'updateTp' ? 'tp' : 'sl'] = value.toString();
      } else if (decoded.functionName === 'openTrade') {
        const [t] = decoded.args;
        const orderId = state.nextOrderId;
        state.nextOrderId += 1n;
        state.orders.push({
          orderId: orderId.toString(),
          pairIndex: t.pairIndex,
          trader: t.trader,
          buy: t.buy,
          collateral: t.collateral.toString(),
          leverage: t.leverage.toString(),
          requestedAt: Math.floor(Date.now() / 1000),
          status: 'pending',
        });

        const topics = encodeEventTopics({
          abi: TRADING_ABI,
          eventName: 'MarketOpenOrderInitiated',
          args: { orderId, trader: t.trader, pairIndex: t.pairIndex },
        });
        logs = [
          {
            address: TRADING_ADDRESS,
            topics,
            data: '0x' as Hex,
            blockHash: numberToHex(blockCounter + 1000),
            blockNumber: numberToHex(blockCounter),
            transactionHash: hash,
            transactionIndex: '0x0',
            logIndex: '0x0',
            removed: false,
          },
        ];
      } else if (decoded.functionName === 'closeTradeMarket') {
        const [pairIndex, index] = decoded.args;
        const position = state.positions.find((p) => p.pairIndex === pairIndex && p.index === index);
        if (position) {
          state.positions = state.positions.filter((p) => p !== position);
        }
      }

      receipts.set(hash, makeReceipt(hash, to, logs));
      return hash;
    }

    receipts.set(hash, makeReceipt(hash, to, []));
    return hash;
  }

  async function handleRequest({ method, params = [] }: EthRequestPayload): Promise<unknown> {
    switch (method) {
      case 'eth_chainId':
        return CHAIN_ID_HEX;
      case 'net_version':
        return String(CHAIN_ID);
      case 'eth_requestAccounts':
      case 'eth_accounts':
        return [MOCK_TRADER_ADDRESS];
      case 'wallet_switchEthereumChain':
      case 'wallet_addEthereumChain':
        return null;
      case 'eth_blockNumber':
        blockCounter += 1;
        return numberToHex(blockCounter);
      case 'eth_getBlockByNumber':
        return { number: numberToHex(blockCounter), hash: numberToHex(blockCounter + 1000), timestamp: numberToHex(Math.floor(Date.now() / 1000)) };
      case 'eth_gasPrice':
        return '0x3b9aca00';
      case 'eth_estimateGas':
        return '0x30d40'; // 200,000; the app pads it (lib/gas.ts)
      case 'eth_getTransactionCount':
        return numberToHex(receiptCounter);
      case 'eth_call':
        return safeHandleCall((params[0] as { to?: string; data?: Hex }) ?? {});
      case 'eth_sendTransaction':
        return handleSendTransaction((params[0] as { to?: string; data?: Hex }) ?? {});
      case 'eth_getTransactionReceipt':
        return receipts.get(params[0] as string) ?? null;
      default:
        return null;
    }
  }

  return { handleRequest };
}
