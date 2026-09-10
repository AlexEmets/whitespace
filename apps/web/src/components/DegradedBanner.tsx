/**
 * Design §5.2 / §7: below MIN_HEALTHY_VENUES the market is in degraded mode — closes
 * allowed, opens blocked. This banner is the honest surface for that, and
 * OpenPositionForm independently disables the open control (belt-and-braces: a UI bug
 * here must not silently let a trader submit an order the system already decided not to
 * price).
 */
/**
 * `healthyVenues` is the list of venue NAMES the API sends, not a count. It used to be
 * typed as a number here, so this banner printed the array where it meant to print a
 * tally — "only bybit,okx healthy venues". Naming them is strictly more useful anyway: it
 * tells the trader which side of the feed is missing, not just how much of it.
 */
export function DegradedBanner({ healthyVenues }: { healthyVenues: string[] | null }) {
  const count = healthyVenues?.length ?? 0;
  return (
    <div role="alert" className="banner banner-degraded" data-testid="degraded-banner">
      Price feed degraded: only {count} healthy venue{count === 1 ? '' : 's'}
      {count > 0 ? ` (${healthyVenues!.join(', ')})` : ''} — minimum 3 required. Opening new positions is disabled.
      Closing existing positions is still allowed.
    </div>
  );
}
