/**
 * Replaces the mockup's order book. Design spec §3.2 deliberately rejects an order book
 * for this product — it is a vault-backed, oracle-priced perp with no resting orders and
 * no counterparties to list (see docs/superpowers/specs/2026-09-08-whitechain-perp-dex-
 * design.md §3.2). Rendering fake bids/asks would show a trader liquidity that does not
 * exist.
 *
 * The honest replacement is a price-impact-by-size ladder — the contract does apply
 * spread and price impact as a function of trade size and open interest
 * (IOstiumPairInfos' dynamic-spread/price-impact machinery). Sourcing that curve
 * correctly (Hill-function price impact, funding-adjusted) was judged too large a
 * surface to add safely within this task's time budget — a wrong price-impact number is
 * exactly the class of bug this app's decimal-safety rules exist to prevent. Per the
 * explicit design-review ruling, this panel is therefore rendered as an honest
 * unavailable state instead of guessed numbers.
 */
export function DepthPanel() {
  return (
    <div className="depth-panel" data-testid="depth-panel">
      <div className="field-label-row">
        <span className="mono-upper">Price impact</span>
      </div>
      <div className="empty-state" data-testid="depth-panel-empty">
        No order book — Whitespace is a vault-backed, oracle-priced perp with no resting orders (design §3.2).
        <br />
        A size-based price-impact ladder is not yet available from this app.
      </div>
    </div>
  );
}
