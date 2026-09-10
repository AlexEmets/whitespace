import { parseAbi } from 'viem';

/**
 * The three `IOstiumPairInfos` reads the price-impact ladder needs, kept in their own
 * module so the shared `src/lib/abi.ts` surface stays untouched.
 *
 * source: contracts/src/vendor/ostium/interfaces/IOstiumPairInfos.sol:162,163,251 and the
 * public mappings they are generated from,
 * contracts/src/vendor/ostium/OstiumPairInfos.sol:60-61:
 *
 *     mapping(uint16 => DynamicSpreadParams) public pairDynamicSpreadParams;
 *     mapping(uint16 => DynamicSpreadState)  public pairDynamicSpreadState;
 *
 * MUTABILITY — the interface declares both mapping getters *without* `view`
 * (`function pairDynamicSpreadParams(uint16) external returns (...)`), which would make
 * viem treat them as writes and refuse `readContract`. They are compiler-generated public
 * mapping getters and cannot mutate state, so they are declared `view` here. That is not
 * taken on trust: both were called against the live deployment
 * (0xF87205EbCf03513D24B998925109FcB84Ce84ED1 on chain 1874) with `eth_call` and returned
 * data rather than reverting.
 *
 * Field order follows the structs at IOstiumPairInfos.sol:5-15 — getters for a struct
 * mapping flatten the members positionally, so the tuple order IS the struct order:
 *   DynamicSpreadParams { uint256 netVolThreshold; uint128 decayRate; uint256 priceImpactK }
 *   DynamicSpreadState  { uint256 buyVolume; uint256 sellVolume; uint32 lastUpdateTimestamp }
 *
 * Note `pairDynamicSpreadParams`' third member IS `priceImpactK`; `getPairPriceImpactK`
 * (OstiumPairInfos.sol:966-968) just returns it. Both are read, and the hook asserts they
 * agree — a cheap, free check that the ABI tuple is being decoded in the right order.
 */
export const PAIR_INFOS_IMPACT_ABI = parseAbi([
  'function getPairPriceImpactK(uint16 pairIndex) view returns (uint256)',
  'function pairDynamicSpreadParams(uint16 pairIndex) view returns (uint256 netVolThreshold, uint128 decayRate, uint256 priceImpactK)',
  'function pairDynamicSpreadState(uint16 pairIndex) view returns (uint256 buyVolume, uint256 sellVolume, uint32 lastUpdateTimestamp)',
]);
