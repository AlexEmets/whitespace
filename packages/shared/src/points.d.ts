export const POINTS_DECIMALS: number;
export const POINTS_SCALE: bigint;

export type MissionId =
  | 'first_market_trade'
  | 'limit_filled'
  | 'stop_triggered'
  | 'take_profit_hit'
  | 'stop_loss_hit'
  | 'edit_tp_sl'
  | 'margin_edit'
  | 'partial_close'
  | 'close_empty_wallet'
  | 'pool_deposit_claim'
  | 'pool_withdraw_claim'
  | 'survive_liquidation';

export interface Mission {
  id: MissionId;
  label: string;
  points: number;
}

export const MISSIONS: ReadonlyArray<Mission>;
export const MAX_MISSION_POINTS_RAW: bigint;
export function isMissionId(id: string): id is MissionId;
export function missionPointsRaw(id: string): bigint;

export const MIN_HELD_SECONDS: number;
export const NOTIONAL_CAP_RAW: bigint;
export const TIME_DAILY_CAP_RAW: bigint;
export function timeInMarketPointsRaw(args: { notionalRaw: bigint; heldSeconds: number }): bigint;

export const STREAK_BASE_RAW: bigint;
export const STREAK_MIN_HELD_SECONDS: number;
export const STREAK_PEAK_DAY: number;
export function streakMultiplierBps(dayIndex: number): bigint;
export function streakDayAwardRaw(dayIndex: number): bigint;

export const LP_DAILY_CAP_RAW: bigint;
export function lpPointsRaw(args: { balanceRaw: bigint; heldSeconds: number }): bigint;

export function creditUnderCap(accruedTodayRaw: bigint, addRaw: bigint, capRaw: bigint): bigint;
export function utcDayIndex(unixSeconds: number): number;
export function seasonTotalRaw(parts: {
  missionsRaw?: bigint;
  timeRaw?: bigint;
  streakRaw?: bigint;
  lpRaw?: bigint;
}): bigint;
