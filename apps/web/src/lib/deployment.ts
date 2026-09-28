import type { Address } from 'viem';
import deployment1874 from '../../../../deployments/1874.json' assert { type: 'json' };

/**
 * Live contract addresses on Whitechain testnet 1874, read directly from the repo-root
 * `deployments/1874.json` (produced by `contracts/script/Deploy.s.sol`) rather than
 * copy-pasted, so a redeploy only has to update one file.
 */
export const DEPLOYMENT_1874 = deployment1874 as {
  chainId: number;
  deployedAt: string;
  commit: string;
  contracts: {
    registry: Address;
    collateral: Address;
    tradingStorage: Address;
    pairsStorage: Address;
    pairInfos: Address;
    trading: Address;
    callbacks: Address;
    vault: Address;
    openPnl: Address;
    priceRouter: Address;
    verifier: Address;
    priceUpKeep: Address;
  };
  libraries: Record<string, Address>;
};

export const TRADING_ADDRESS = DEPLOYMENT_1874.contracts.trading;
export const VAULT_ADDRESS = DEPLOYMENT_1874.contracts.vault;
export const COLLATERAL_ADDRESS = DEPLOYMENT_1874.contracts.collateral;
export const TRADING_STORAGE_ADDRESS = DEPLOYMENT_1874.contracts.tradingStorage;
export const PAIR_INFOS_ADDRESS = DEPLOYMENT_1874.contracts.pairInfos;
export const PAIRS_STORAGE_ADDRESS = DEPLOYMENT_1874.contracts.pairsStorage;
export const CALLBACKS_ADDRESS = DEPLOYMENT_1874.contracts.callbacks;
