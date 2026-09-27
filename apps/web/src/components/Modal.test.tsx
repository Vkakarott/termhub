// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
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
  });
});
