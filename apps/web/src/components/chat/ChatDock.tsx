import { useEffect } from 'react';
import { useData } from '../../lib/data';
import { useNarrowWindow } from '../../lib/narrow-window';
import { useProjectChat } from '../../lib/project-chat';
import { trackAppHeight } from '../../lib/viewport';
import { ChatPanel } from './ChatPanel';
import { ChatResizer } from './ChatResizer';

/**
 * The project chat, docked in the project window (spec 2026-09-26 project chat dock §4.5). Rendered in
 * `Layout` right after `main`, so on desktop it is a column beside the page and the terminals re-fit
 * to the space left. Only the project on screen shows its chat, and only when it is open there.
 *
 * Every alive panel is rendered here, under this one parent and keyed by project, so showing another
 * one only changes classes: nothing remounts, and an answer keeps streaming into the panel left
 * behind. The hidden ones sit off screen with their last width (laid out, so the thread keeps its
 * scroll and never reads 0×0) and `inert`, so focus and screen readers skip them. They are rendered in
 * a stable order: a keyed reorder would move DOM nodes, which can reset their scroll.
 *
 * Escape does not close it: next to a terminal, Escape belongs to the program running there.
 */
export function ChatDock() {
  const { alive, shownProjectId, pref, setOpen, setWidth, setMaximized } = useProjectChat();
  const { projects } = useData();
  const narrow = useNarrowWindow();
  const fullScreen = narrow && shownProjectId !== null;

  // On a phone the chat covers the page, with the same viewport handling as `/chat` (ChatLayout), so the
  // composer stays above the keyboard and a drag on it does not pan the document.
  useEffect(() => (fullScreen ? trackAppHeight() : undefined), [fullScreen]);
  useEffect(() => {
    if (!fullScreen) return;
    document.body.classList.add('chat-locked');
    return () => document.body.classList.remove('chat-locked');
  }, [fullScreen]);

  const ids = [...new Set(shownProjectId ? [...alive, shownProjectId] : alive)].sort();
  if (ids.length === 0) return null;

  return (
    <>
      {ids.map((id) => {
        const shown = id === shownProjectId;
        const p = pref(id);
        const title = `Chat · ${projects.find((x) => x.id === id)?.name ?? 'projeto'}`;
        const docked = shown && !narrow && !p.maximized;
        const place = !shown
          ? 'fixed top-0 -left-[200vw] h-full'
          : narrow
            ? 'fixed inset-x-0 top-0 z-40 h-[var(--app-height,100svh)]'
            : p.maximized
              ? 'relative min-w-0 flex-1'
              : 'relative max-w-[60%] shrink-0';
        return (
          <aside
            key={id}
            aria-label={title}
            aria-hidden={shown ? undefined : true}
            inert={!shown}
            className={`flex flex-col border-l border-line bg-bg ${place}`}
            style={shown && (narrow || p.maximized) ? undefined : { width: p.width }}
          >
            {docked && <ChatResizer width={p.width} onCommit={(w) => setWidth(id, w)} />}
            <header className="flex h-11 shrink-0 items-center gap-2 border-b border-line bg-bg-2 px-3">
              <h2 className="min-w-0 flex-1 truncate text-sm font-semibold text-fg">{title}</h2>
              {!narrow && (
                <button
                  type="button"
                  className="rounded px-2 py-1 text-sm text-fg-dim hover:bg-bg-3 hover:text-fg"
                  aria-label={p.maximized ? 'Sair da tela cheia' : 'Tela cheia'}
                  title={p.maximized ? 'Sair da tela cheia' : 'Tela cheia'}
                  onClick={() => setMaximized(id, !p.maximized)}
                >
                  {p.maximized ? '⤡' : '⤢'}
                </button>
              )}
              <button type="button" className="rounded px-2 py-1 text-sm text-fg-dim hover:bg-bg-3 hover:text-fg" aria-label="Fechar chat" title="Fechar" onClick={() => setOpen(id, false)}>
                ✕
              </button>
            </header>
            <div className="flex min-h-0 flex-1 flex-col">
              <ChatPanel projectId={id} />
            </div>
          </aside>
        );
      })}
    </>
  );
}
