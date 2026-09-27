import { useEffect, useRef, type KeyboardEvent as ReactKeyboardEvent, type ReactNode, type RefObject } from 'react';

// Open layers (modals, the chat drawer), innermost last: only the top one answers Escape, so closing a
// nested dialog never closes the one under it too.
const openStack: symbol[] = [];

/**
 * Joins the stack of open layers for as long as `open` is true: only the top one answers Escape, so a
 * dialog opened from the chat drawer closes before the drawer does. Keyed on `open` only, so a
 * re-render with a new callback keeps the stack order. A `base` layer (a page's own Esc, like leaving
 * settings) goes under every other layer, whenever each opened: a dialog or the chat drawer always
 * answers first, even one opened before the page's layer joined.
 */
export function useEscapeLayer(open: boolean, onEscape: (e: KeyboardEvent) => void, enabled = true, options: { base?: boolean } = {}): void {
  const latest = useRef({ onEscape, enabled });
  latest.current = { onEscape, enabled };
  const base = !!options.base;
  useEffect(() => {
    if (!open) return;
    const id = Symbol('layer');
    if (base) openStack.unshift(id);
    else openStack.push(id);
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || openStack[openStack.length - 1] !== id) return;
      if (latest.current.enabled) latest.current.onEscape(e);
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      openStack.splice(openStack.indexOf(id), 1);
    };
  }, [open, base]);
}

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

const focusables = (root: HTMLElement) =>
  Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((el) => !el.hidden && !el.closest('[inert]'));

/**
 * Focus for a modal layer (TER-199): on open, focus goes in — unless something inside already took it
 * (an `autoFocus` field; React applies it during commit, before this effect) — to `initialFocusRef` or
 * else the container itself (give it `tabIndex={-1}`). Tab and Shift+Tab wrap inside through the returned
 * `onKeyDown`, which only sees keys pressed inside this dialog, so stacked layers do not fight. On close,
 * focus goes back to what had it before, if that is still in the document.
 */
export function useDialogFocus(open: boolean, containerRef: RefObject<HTMLElement | null>, initialFocusRef?: RefObject<HTMLElement | null>) {
  // The opener is read during the render that opens the dialog: by the time any effect runs, an
  // `autoFocus` child has already taken focus, and the opener would be lost.
  const opener = useRef<HTMLElement | null>(null);
  const wasOpen = useRef(false);
  if (open && !wasOpen.current) opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  wasOpen.current = open;

  useEffect(() => {
    if (!open) return;
    const container = containerRef.current;
    if (container && !container.contains(document.activeElement)) (initialFocusRef?.current ?? container).focus();
    return () => {
      const back = opener.current;
      if (back && back.isConnected) back.focus();
    };
  }, [open, containerRef, initialFocusRef]);

  return (e: ReactKeyboardEvent) => {
    const container = containerRef.current;
    if (e.key !== 'Tab' || !container) return;
    const items = focusables(container);
    if (items.length === 0) {
      e.preventDefault();
      container.focus();
      return;
    }
    const first = items[0]!;
    const last = items[items.length - 1]!;
    const active = document.activeElement;
    if (e.shiftKey && (active === first || active === container)) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && active === last) {
      e.preventDefault();
      first.focus();
    }
  };
}

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
  useEscapeLayer(open, onClose, dismissible);
  const dialogRef = useRef<HTMLDivElement>(null);
  const onKeyDown = useDialogFocus(open, dialogRef);

  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onMouseDown={dismissible ? onClose : undefined}>
      <div
        ref={dialogRef}
        tabIndex={-1}
        onKeyDown={onKeyDown}
        className={`flex max-h-[calc(100vh-2rem)] w-full ${width} flex-col rounded-lg border border-line bg-bg-2 shadow-2xl outline-none`}
        onMouseDown={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label={title}
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
