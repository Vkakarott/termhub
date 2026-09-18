import { useEffect, useRef, useState } from 'react';
import { PRESETS, type Preset } from '../lib/layout';
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
  preset: Preset;
  onPreset: (p: Preset) => void;
  /** whether the tab is currently on screen (in a cell or floating) */
  onScreen: (tabId: string) => boolean;
}

/** 16×12 glyph of the preset's cell arrangement. */
function PresetIcon({ preset }: { preset: Preset }) {
  const cells: [number, number, number, number][] =
    preset === 'single'
      ? [[0, 0, 16, 12]]
      : preset === 'columns'
        ? [
            [0, 0, 7.5, 12],
            [8.5, 0, 7.5, 12],
          ]
        : preset === 'rows'
          ? [
              [0, 0, 16, 5.5],
              [0, 6.5, 16, 5.5],
            ]
          : preset === 'stack-left'
            ? [
                [0, 0, 7.5, 5.5],
                [0, 6.5, 7.5, 5.5],
                [8.5, 0, 7.5, 12],
              ]
            : [
                [0, 0, 7.5, 5.5],
                [0, 6.5, 7.5, 5.5],
                [8.5, 0, 7.5, 5.5],
                [8.5, 6.5, 7.5, 5.5],
              ];
  return (
    <svg width="16" height="12" viewBox="0 0 16 12" aria-hidden>
      {cells.map(([x, y, w, h], i) => (
        <rect key={i} x={x} y={y} width={w} height={h} rx="1" fill="currentColor" />
      ))}
    </svg>
  );
}

export function TabBar({ tabs, activeId, onSelect, onNew, onNewSimulator, canSimulator, onRename, onClose, preset, onPreset, onScreen }: Props) {
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
    <div className="flex h-9 shrink-0 items-stretch border-b border-line bg-bg-2">
      <div className="flex min-w-0 flex-1 items-stretch overflow-x-auto">
        {tabs.map((t, i) => {
          const active = t.id === activeId;
          const shown = onScreen(t.id);
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
              {(active || shown) && <span className={`absolute inset-x-0 top-0 h-px ${active ? 'bg-accent' : 'bg-accent/40'}`} />}
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
      <div className="ml-auto flex shrink-0 items-center gap-0.5 px-2" role="radiogroup" aria-label="Arranjo dos painéis">
        {PRESETS.map((p) => (
          <button
            key={p.key}
            role="radio"
            aria-checked={preset === p.key}
            className={`rounded p-0.5 ${preset === p.key ? 'bg-bg-4 text-fg' : 'text-fg-dim hover:bg-bg-3 hover:text-fg'}`}
            onClick={() => onPreset(p.key)}
            title={p.label}
          >
            <PresetIcon preset={p.key} />
          </button>
        ))}
      </div>
    </div>
  );
}
