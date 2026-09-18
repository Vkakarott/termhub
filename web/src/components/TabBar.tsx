import { useEffect, useRef, useState } from 'react';
import type { Tab } from '../lib/types';

interface Props {
  tabs: Tab[];
  activeId: string | null;
  onSelect: (id: string) => void;
  onNew: () => void;
  onNewSimulator?: () => void;
  canSimulator: boolean;
  onRename: (id: string, name: string) => void;
  onClose: (id: string) => void;
}

export function TabBar({ tabs, activeId, onSelect, onNew, onNewSimulator, canSimulator, onRename, onClose }: Props) {
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (editing) inputRef.current?.select();
  }, [editing]);

  const commit = () => {
    if (editing && draft.trim()) onRename(editing, draft.trim());
    setEditing(null);
  };

  return (
    <div className="flex h-9 shrink-0 items-stretch overflow-x-auto border-b border-line bg-bg-2">
      {tabs.map((t, i) => {
        const active = t.id === activeId;
        return (
          <div
            key={t.id}
            className={`group relative flex min-w-[120px] max-w-[220px] cursor-pointer select-none items-center gap-2 border-r border-line px-3 text-xs ${
              active ? 'bg-bg text-fg' : 'text-fg-muted hover:bg-bg-3 hover:text-fg'
            }`}
            onClick={() => onSelect(t.id)}
            onDoubleClick={() => {
              setEditing(t.id);
              setDraft(t.name);
            }}
            title={`${t.name} — ${t.kind === 'simulator' ? 'simulador iOS' : t.tmux_session}${i < 9 ? `  (⌘${i + 1})` : ''}`}
          >
            {active && <span className="absolute inset-x-0 top-0 h-px bg-accent" />}
            <span
              className={`h-1.5 w-1.5 shrink-0 rounded-full ${t.alive ? 'bg-ok' : 'bg-fg-dim'}`}
              title={t.kind === 'simulator' ? (t.alive ? 'simulador conectado' : 'simulador desconectado') : t.alive ? 'sessão tmux ativa' : 'sessão tmux não iniciada'}
            />
            {t.kind === 'simulator' && (
              <span className="text-[10px]" aria-hidden>
                📱
              </span>
            )}
            {editing === t.id ? (
              <input
                ref={inputRef}
                className="w-full bg-transparent outline-none"
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onBlur={commit}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') commit();
                  if (e.key === 'Escape') setEditing(null);
                }}
                onClick={(e) => e.stopPropagation()}
              />
            ) : (
              <span className="truncate">{t.name}</span>
            )}
            <button
              className={`ml-auto rounded px-1 text-fg-dim hover:bg-bg-4 hover:text-fg ${active ? '' : 'invisible group-hover:visible'}`}
              onClick={(e) => {
                e.stopPropagation();
                onClose(t.id);
              }}
              title="Fechar tab (⌘W)"
              aria-label="Fechar tab"
            >
              ✕
            </button>
          </div>
        );
      })}
      <button className="px-3 text-sm text-fg-dim hover:bg-bg-3 hover:text-fg" onClick={onNew} title="Nova tab (⌘T)" aria-label="Nova tab">
        +
      </button>
      {canSimulator && (
        <button className="px-2 text-sm text-fg-dim hover:bg-bg-3 hover:text-fg" onClick={onNewSimulator} title="Novo simulador iOS" aria-label="Novo simulador iOS">
          📱
        </button>
      )}
    </div>
  );
}
