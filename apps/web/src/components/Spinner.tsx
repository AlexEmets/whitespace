/**
 * A small inline busy indicator for "waiting on chain" states (a close or an order waiting
 * for its price report). It replaces sentences about the keeper: the trader needs to see
 * that something is in progress, not how the oracle pipeline works.
 */
export function Spinner({ label, testId }: { label: string; testId?: string }) {
  return <span className="spinner" role="status" aria-label={label} title={label} data-testid={testId} />;
}
