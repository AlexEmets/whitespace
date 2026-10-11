'use client';

import { useEffect } from 'react';
import { createPortal } from 'react-dom';

export interface FillNotice {
  /** The order that filled; a new id restarts the timer even when the text is the same. */
  id: string;
  text: string;
}

export const FILL_TOAST_MS = 4000;

/**
 * A quiet confirmation in the corner that a market order filled and the position is open.
 *
 * The form's own banner says the same, but it sits under the button and goes the moment the
 * trader edits the next order — and with one-click trading there is no wallet prompt either,
 * so a fill landing a few seconds later had nothing to show for it. This one is outside the
 * form, survives edits, and leaves on its own. Nothing here fetches: it is driven by the
 * orders the page already holds.
 */
export function FillToast({ notice, onDismiss }: { notice: FillNotice | null; onDismiss: () => void }) {
  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(onDismiss, FILL_TOAST_MS);
    return () => clearTimeout(timer);
    // Keyed on the order, not the callback: a parent re-render must not restart the clock.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [notice?.id]);

  if (!notice || typeof document === 'undefined') return null;
  return createPortal(
    <div className="fill-toast" role="status" data-testid="fill-toast">
      <span className="fill-toast-dot" aria-hidden="true" />
      <span className="fill-toast-text">
        <b>Position opened</b> {notice.text}
      </span>
      <button type="button" className="fill-toast-close" aria-label="Dismiss" data-testid="fill-toast-close" onClick={onDismiss}>
        ×
      </button>
    </div>,
    document.body,
  );
}
