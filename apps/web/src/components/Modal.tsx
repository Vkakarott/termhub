import { useEffect, useRef, type ReactNode } from 'react';

// Open modals, innermost last: only the top one answers Escape, so closing a
// nested dialog never closes the one under it too.
const openStack: symbol[] = [];

interface Props {
  title: string;
  open: boolean;
  onClose: () => void;
  children: ReactNode;
  width?: string;
  /** false disables Escape and backdrop-click dismissal; the header × still closes it. Default true. */
  dismissible?: boolean;
}

export function Modal({ title, open, onClose, children, width = 'max-w-md', dismissible = true }: Props) {
  const latest = useRef({ onClose, dismissible });
  latest.current = { onClose, dismissible };

  // keyed on `open` only, so re-renders with a new onClose keep the stack order
  useEffect(() => {
    if (!open) return;
    const id = Symbol('modal');
    openStack.push(id);
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || openStack[openStack.length - 1] !== id) return;
      if (latest.current.dismissible) latest.current.onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      openStack.splice(openStack.indexOf(id), 1);
    };
  }, [open]);

  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onMouseDown={dismissible ? onClose : undefined}>
      <div
        className={`flex max-h-[calc(100vh-2rem)] w-full ${width} flex-col rounded-lg border border-line bg-bg-2 shadow-2xl`}
        onMouseDown={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
      >
        <div className="flex shrink-0 items-center justify-between border-b border-line px-4 py-3">
          <h2 className="text-sm font-semibold">{title}</h2>
          <button className="text-fg-dim hover:text-fg" onClick={onClose} aria-label="Fechar">
            ✕
          </button>
        </div>
        <div className="min-h-0 overflow-y-auto p-4">{children}</div>
      </div>
    </div>
  );
}

interface ConfirmProps {
  open: boolean;
  title: string;
  message: ReactNode;
  confirmLabel?: string;
  danger?: boolean;
  onConfirm: () => void | Promise<void>;
  onCancel: () => void;
}

export function ConfirmDialog({ open, title, message, confirmLabel = 'Confirmar', danger, onConfirm, onCancel }: ConfirmProps) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Enter') void onConfirm();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onConfirm]);

  return (
    <Modal title={title} open={open} onClose={onCancel} width="max-w-sm">
      <div className="text-sm text-fg-muted">{message}</div>
      <div className="mt-4 flex justify-end gap-2">
        <button className="btn-ghost" onClick={onCancel}>
          Cancelar
        </button>
        <button className={danger ? 'btn-danger' : 'btn-primary'} onClick={() => void onConfirm()} autoFocus>
          {confirmLabel}
        </button>
      </div>
    </Modal>
  );
}
