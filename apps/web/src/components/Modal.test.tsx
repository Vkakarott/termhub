// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { StrictMode, useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ConfirmDialog, Modal } from './Modal';

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

function FocusHarness({ autoFocus = false }: { autoFocus?: boolean }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button onClick={() => setOpen(true)}>Abrir</button>
      <Modal title="Renomear" open={open} onClose={() => setOpen(false)}>
        <input aria-label="Nome" autoFocus={autoFocus} />
        <button>Salvar</button>
      </Modal>
    </>
  );
}

describe('Modal focus', () => {
  it('moves focus into the dialog and gives it back to the opener on close', () => {
    render(<FocusHarness />);
    const opener = screen.getByRole('button', { name: 'Abrir' });
    opener.focus();
    fireEvent.click(opener);
    expect(document.activeElement).toBe(screen.getByRole('dialog'));
    fireEvent.click(screen.getByRole('button', { name: 'Fechar' }));
    expect(document.activeElement).toBe(opener);
  });

  it('keeps an autoFocus field focused, and still gives focus back to the opener', () => {
    render(<FocusHarness autoFocus />);
    const opener = screen.getByRole('button', { name: 'Abrir' });
    opener.focus();
    fireEvent.click(opener);
    expect(document.activeElement).toBe(screen.getByRole('textbox', { name: 'Nome' }));
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(document.activeElement).toBe(opener);
  });

  it('keeps ConfirmDialog on its confirm button', () => {
    render(<ConfirmDialog open title="Excluir" message="Certeza?" confirmLabel="Excluir" onConfirm={() => {}} onCancel={() => {}} />);
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Excluir' }));
  });

  it("keeps ConfirmDialog on its confirm button under StrictMode's double effect", () => {
    // StrictMode (apps/web/src/main.tsx) fake-cleans-up and re-runs every effect once in dev, right
    // after mount. A naive cleanup that unconditionally gives focus back to the opener would fire during
    // that fake cleanup too — while the dialog is still mounted and the confirm button still has focus —
    // and steal it. A real (still-connected, still-focusable) opener is needed to catch this: giving
    // focus back to <body> is a no-op, so an opener captured with nothing focused would hide the bug.
    const trigger = document.createElement('button');
    document.body.appendChild(trigger);
    trigger.focus();
    render(
      <StrictMode>
        <ConfirmDialog open title="Excluir" message="Certeza?" confirmLabel="Excluir" onConfirm={() => {}} onCancel={() => {}} />
      </StrictMode>,
    );
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Excluir' }));
    trigger.remove();
  });

  it('keeps the newly opened dialog focused when a Modal closes and a ConfirmDialog opens in the same update', () => {
    function SwapHarness() {
      const [phase, setPhase] = useState<'closed' | 'modal' | 'confirm'>('closed');
      return (
        <>
          <button onClick={() => setPhase('modal')}>Abrir</button>
          <Modal title="Renomear" open={phase === 'modal'} onClose={() => setPhase('closed')}>
            <button onClick={() => setPhase('confirm')}>Excluir…</button>
          </Modal>
          <ConfirmDialog open={phase === 'confirm'} title="Excluir" message="Certeza?" confirmLabel="Excluir" onConfirm={() => {}} onCancel={() => {}} />
        </>
      );
    }
    render(<SwapHarness />);
    // "Abrir" becomes the Modal's own opener (still connected when it closes), same as the reported
    // bug: closing the rename Modal from inside it, straight into a confirm dialog, in one update.
    fireEvent.click(screen.getByRole('button', { name: 'Abrir' }));
    fireEvent.click(screen.getByRole('button', { name: 'Excluir…' }));
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Excluir' }));
  });

  it('wraps Tab and Shift+Tab inside the dialog', () => {
    render(<FocusHarness />);
    fireEvent.click(screen.getByRole('button', { name: 'Abrir' }));
    const dialog = screen.getByRole('dialog');
    const close = screen.getByRole('button', { name: 'Fechar' });
    const save = screen.getByRole('button', { name: 'Salvar' });
    save.focus();
    fireEvent.keyDown(dialog, { key: 'Tab' });
    expect(document.activeElement).toBe(close);
    fireEvent.keyDown(dialog, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(save);
  });

  it('wraps Tab inside the inner dialog of two nested modals, without the outer one also acting on it', () => {
    // Modal renders in place (no portal), so a nested Modal's DOM sits inside the outer one's own
    // container: the same Tab keydown bubbles through both onKeyDown handlers.
    render(
      <Modal title="fora" open onClose={() => {}}>
        <Modal title="dentro" open onClose={() => {}}>
          <button>Salvar</button>
        </Modal>
      </Modal>,
    );
    const innerClose = screen.getAllByRole('button', { name: 'Fechar' })[1]!;
    const innerSave = screen.getByRole('button', { name: 'Salvar' });
    innerSave.focus();
    fireEvent.keyDown(innerSave, { key: 'Tab' });
    expect(document.activeElement).toBe(innerClose);
  });

  it('does nothing when the opener is gone', () => {
    const { rerender } = render(
      <Modal title="X" open={false} onClose={() => {}}>
        <p>x</p>
      </Modal>,
    );
    const opener = document.createElement('button');
    document.body.appendChild(opener);
    opener.focus();
    rerender(
      <Modal title="X" open onClose={() => {}}>
        <p>x</p>
      </Modal>,
    );
    opener.remove();
    expect(() =>
      rerender(
        <Modal title="X" open={false} onClose={() => {}}>
          <p>x</p>
        </Modal>,
      ),
    ).not.toThrow();
    expect(document.activeElement).toBe(document.body);
  });
});
