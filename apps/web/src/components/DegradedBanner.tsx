/**
 * Design §5.2 / §7: below MIN_HEALTHY_VENUES the market is in degraded mode — closes
 * allowed, opens blocked. This banner is the honest surface for that, and
 * OpenPositionForm independently disables the open control (belt-and-braces: a UI bug
 * here must not silently let a trader submit an order the system already decided not to
 * price).
 */
export function DegradedBanner({ healthyVenues }: { healthyVenues: number }) {
  return (
    <div role="alert" className="banner banner-degraded" data-testid="degraded-banner">
      Price feed degraded: only {healthyVenues} healthy venue{healthyVenues === 1 ? '' : 's'} (minimum 3 required).
      Opening new positions is disabled. Closing existing positions is still allowed.
    </div>
  );
}
