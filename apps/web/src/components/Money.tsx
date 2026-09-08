import { formatMoney, type FormatMoneyOptions, type MoneyInput } from '@/lib/money';

/**
 * The only place a monetary value should be dropped into JSX. Takes the raw scaled
 * value (bigint or the raw decimal string exactly as the API sends it) and formats it
 * through src/lib/money.ts — never accepts a `number`, so a stray `Number(x)` upstream
 * cannot silently reach the screen.
 */
export function Money({
  value,
  decimals,
  options,
  suffix,
  className,
}: {
  value: MoneyInput;
  decimals: number;
  options?: FormatMoneyOptions;
  suffix?: string;
  className?: string;
}) {
  const formatted = formatMoney(value, decimals, options);
  return (
    <span className={className}>
      {formatted}
      {suffix ? ` ${suffix}` : ''}
    </span>
  );
}
