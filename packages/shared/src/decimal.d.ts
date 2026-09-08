export const PRICE_DECIMALS: bigint;
export const PRICE_SCALE: bigint;

export function parseDecimalTo18(input: string | number): bigint;
export function formatFixed18(value: bigint): string;
export function bpsOf(numerator: bigint, denominator: bigint): bigint | null;
export function deviationBps(value: bigint, reference: bigint): bigint | null;

export const SCALE: {
  PRICE: number;
  COLLATERAL: number;
  LEVERAGE: number;
};

export function toDecimalString(raw: bigint | string | number, decimals: number): string;
export function parseDecimalToBigInt(input: string | bigint | number, decimals: number): bigint;
