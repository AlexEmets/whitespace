'use client';

import { useEffect, useRef, type ReactNode, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { useMounted } from '@/hooks/useMounted';
import styles from './Modal.module.css';

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled])';

function trapFocus(container: HTMLElement | null, event: KeyboardEvent): void {
  if (!container) return;
  const items = Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE));
  const first = items[0];
  const last = items[items.length - 1];
  if (!first || !last) return;
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
}

/**
 * The app's dialog shell: portal, focus trap, Esc and backdrop close, scroll lock, and
 * focus returned to whatever opened it.
 *
 * Extracted from WalletPicker rather than written afresh for the funding dialogs. A focus
 * trap is small but easy to get subtly wrong, and two copies drift: the second one
 * acquires the bug the first one already fixed. WalletPicker's own markup and testids are
 * unchanged — it passes its id through `testId` and keeps rendering its rows as children.
 *
 * `initialFocusRef` exists because the right first focus is not always the first
 * focusable element. WalletPicker wants the first wallet row, which sits after the close
 * button in DOM order; the funding dialog wants its amount input.
 */
export function Modal({
  open,
  onClose,
  title,
  testId,
  initialFocusRef,
  footer,
  children,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  /** Root gets this; the backdrop gets `<testId>-backdrop`, the close button `<testId>-close`. */
  testId: string;
  initialFocusRef?: RefObject<HTMLElement | null>;
  footer?: ReactNode;
  children: ReactNode;
}) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const mounted = useMounted();

  useEffect(() => {
    if (!open) return undefined;

    const opener = document.activeElement;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    // Falls back to the dialog's own first focusable so focus never stays behind on the
    // page underneath, where Tab would walk the (inert, scroll-locked) document.
    const target = initialFocusRef?.current ?? dialogRef.current?.querySelector<HTMLElement>(FOCUSABLE);
    target?.focus();

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
      else if (event.key === 'Tab') trapFocus(dialogRef.current, event);
    };
    document.addEventListener('keydown', onKeyDown);

    return () => {
      document.removeEventListener('keydown', onKeyDown);
      document.body.style.overflow = previousOverflow;
      if (opener instanceof HTMLElement) opener.focus();
    };
  }, [open, onClose, initialFocusRef]);

  if (!mounted || !open) return null;

  return createPortal(
    <div
      className={styles.backdrop}
      data-testid={`${testId}-backdrop`}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        ref={dialogRef}
        className={styles.dialog}
        role="dialog"
        aria-modal="true"
        aria-labelledby={`${testId}-title`}
        data-testid={testId}
      >
        <header className={styles.header}>
          <h2 id={`${testId}-title`} className={styles.title}>
            {title}
          </h2>
          <button type="button" className={styles.close} onClick={onClose} aria-label="Close" data-testid={`${testId}-close`}>
            ×
          </button>
        </header>

        {children}

        {footer ? <footer className={styles.footer}>{footer}</footer> : null}
      </div>
    </div>,
    document.body,
  );
}
