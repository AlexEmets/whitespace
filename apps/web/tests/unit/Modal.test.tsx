import { fireEvent, render, screen } from '@testing-library/react';
import { useRef } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { Modal } from '@/components/Modal';

function Harness({ onClose = () => {} }: { onClose?: () => void }) {
  const target = useRef<HTMLInputElement>(null);
  return (
    <Modal open onClose={onClose} title="Dialog" testId="dialog" initialFocusRef={target}>
      <button type="button">First</button>
      <input ref={target} data-testid="target" />
    </Modal>
  );
}

/**
 * A dialog that is open from its very first render — the Terms gate, for a wallet that
 * reconnects before the page has painted — used to look for its focus target before its
 * portal existed, and left focus on the page underneath.
 */
describe('<Modal> open from its first render', () => {
  it('moves focus into the dialog, onto the requested element', () => {
    render(<Harness />);
    expect(screen.getByTestId('target')).toHaveFocus();
  });

  it('closes on Escape', () => {
    const onClose = vi.fn();
    render(<Harness onClose={onClose} />);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
