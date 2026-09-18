import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';

export type MenuItem =
  | { kind: 'item'; label: string; onSelect: () => void; disabled?: boolean; href?: string; download?: boolean }
  | { kind: 'radio'; label: string; checked: boolean; onSelect: () => void }
  | { kind: 'separator' }
  | { kind: 'heading'; label: string };

interface Props {
  label?: ReactNode;
  title?: string;
  align?: 'left' | 'right';
  items: MenuItem[];
}

/**
 * Small "⋯" dropdown menu. No portal: the popover is positioned relative to the trigger's
 * wrapper, so the caller must not clip that wrapper with `overflow-hidden`. Flips above the
 * trigger when it would overflow the bottom of the viewport.
 */
export function DropdownMenu({ label = '⋯', title, align = 'right', items }: Props) {
  const [open, setOpen] = useState(false);
  const [placement, setPlacement] = useState<'top' | 'bottom'>('bottom');
  const wrapRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  // Flip above the trigger when the popover would overflow the bottom of the viewport.
  useLayoutEffect(() => {
    if (!open) return;
    const el = menuRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    setPlacement(rect.bottom > window.innerHeight ? 'top' : 'bottom');
  }, [open]);

  // Outside click/pointerdown and Escape close the menu. Listener registered only while open.
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: PointerEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  const close = () => setOpen(false);

  return (
    <div ref={wrapRef} className="relative inline-block">
      <button
        type="button"
        className="btn-ghost px-2 py-0.5"
        title={title}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        {label}
      </button>
      {open && (
        <div
          ref={menuRef}
          role="menu"
          className={`absolute z-40 min-w-[160px] rounded-md border border-line bg-bg-2 py-1 text-xs shadow-xl ${align === 'right' ? 'right-0' : 'left-0'} ${
            placement === 'top' ? 'bottom-full mb-1' : 'top-full mt-1'
          }`}
        >
          {items.map((item, i) => {
            if (item.kind === 'separator') return <div key={i} role="separator" className="my-1 border-t border-line" />;
            if (item.kind === 'heading')
              return (
                <div key={i} className="px-3 py-0.5 text-[10px] uppercase text-fg-dim">
                  {item.label}
                </div>
              );
            if (item.kind === 'radio')
              return (
                <button
                  key={i}
                  type="button"
                  role="menuitemradio"
                  aria-checked={item.checked}
                  className="flex w-full items-center gap-2 px-3 py-1 text-left hover:bg-bg-3"
                  onClick={() => {
                    item.onSelect();
                    close();
                  }}
                >
                  <span className="w-3 shrink-0 text-center" aria-hidden>
                    {item.checked ? '✓' : ''}
                  </span>
                  {item.label}
                </button>
              );
            // kind === 'item'
            if (item.href)
              return (
                <a
                  key={i}
                  role="menuitem"
                  href={item.disabled ? undefined : item.href}
                  download={item.download}
                  aria-disabled={item.disabled}
                  className={`block w-full px-3 py-1 text-left hover:bg-bg-3 ${item.disabled ? 'pointer-events-none opacity-50' : ''}`}
                  onClick={() => {
                    item.onSelect();
                    close();
                  }}
                >
                  {item.label}
                </a>
              );
            return (
              <button
                key={i}
                type="button"
                role="menuitem"
                disabled={item.disabled}
                className="block w-full px-3 py-1 text-left hover:bg-bg-3 disabled:pointer-events-none disabled:opacity-50"
                onClick={() => {
                  item.onSelect();
                  close();
                }}
              >
                {item.label}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
