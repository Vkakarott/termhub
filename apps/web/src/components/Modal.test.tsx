// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Modal } from './Modal';

afterEach(cleanup);

describe('Modal', () => {
  it('Escape closes only the innermost of two open modals', () => {
    const outer = vi.fn();
    const inner = vi.fn();
    const { rerender } = render(
      <Modal title="fora" open onClose={outer}>
        <p>x</p>
      </Modal>,
    );
    rerender(
      <Modal title="fora" open onClose={outer}>
        <Modal title="dentro" open onClose={inner}>
          <p>y</p>
        </Modal>
      </Modal>,
    );
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(inner).toHaveBeenCalledTimes(1);
    expect(outer).not.toHaveBeenCalled();
  });

  it('a non-dismissible modal on top swallows Escape instead of passing it down', () => {
    const outer = vi.fn();
    const inner = vi.fn();
    const { rerender } = render(<Modal title="fora" open onClose={outer}>{null}</Modal>);
    rerender(
      <Modal title="fora" open onClose={outer}>
        <Modal title="dentro" open onClose={inner} dismissible={false}>
          {null}
        </Modal>
      </Modal>,
    );
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(inner).not.toHaveBeenCalled();
    expect(outer).not.toHaveBeenCalled();
  });

  it('once the inner modal closes, Escape reaches the outer one again', () => {
    const outer = vi.fn();
    const { rerender } = render(<Modal title="fora" open onClose={outer}>{null}</Modal>);
    rerender(
      <Modal title="fora" open onClose={outer}>
        <Modal title="dentro" open onClose={() => {}}>
          {null}
        </Modal>
      </Modal>,
    );
    rerender(<Modal title="fora" open onClose={outer}>{null}</Modal>);
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(outer).toHaveBeenCalledTimes(1);
  });
});
