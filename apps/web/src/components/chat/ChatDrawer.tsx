import { useEffect } from 'react';
import { useData } from '../../lib/data';
import { useProjectChat } from '../../lib/project-chat';
import { trackAppHeight } from '../../lib/viewport';
import { useEscapeLayer } from '../Modal';
import { ChatPanel } from './ChatPanel';

/**
 * A project's chat, over whatever page is open (spec 2026-09-23 §5.2). Mounted once in `Layout`,
 * outside the routes, so it survives navigation: the person can open the project's tabs and keep
 * talking. It overlays `main` instead of resizing it, so no terminal re-fits because a chat opened.
 * Closing it stops nothing — a run in progress finishes on the server and is there on reopening.
 */
export function ChatDrawer() {
  const { openProjectId, close } = useProjectChat();
  const { projects } = useData();
  const open = openProjectId !== null;
  useEscapeLayer(open, close);
  // Full screen on a phone: the same viewport handling as `/chat`, so the composer stays above the
  // keyboard (see ChatLayout).
  useEffect(() => (open ? trackAppHeight() : undefined), [open]);
  // The other half of ChatLayout's mobile handling (ChatLayout.tsx:23-26): without `chat-locked` a
  // drag starting on the composer pans the document under the full-screen drawer on iOS. Applied
  // unconditionally, not just below the `md` breakpoint — the rule is inert on desktop, since
  // `Layout` never lets the body itself scroll there. `/chat` (ChatLayout) and this drawer are never
  // mounted at the same time — one lives in `ChatLayout`, the other in `Layout` — so there is no
  // double add/remove race between the two effects that touch this class.
  useEffect(() => {
    if (!open) return;
    document.body.classList.add('chat-locked');
    return () => document.body.classList.remove('chat-locked');
  }, [open]);

  if (!openProjectId) return null;
  const project = projects.find((p) => p.id === openProjectId);
  const title = `Chat · ${project?.name ?? 'projeto'}`;
  return (
    <aside
      role="dialog"
      // No `aria-modal`: the drawer is deliberately non-modal — the page behind it (terminals,
      // tabs) stays usable while it is open.
      aria-label={title}
      className="fixed inset-x-0 top-0 z-40 flex h-[var(--app-height,100svh)] flex-col border-l border-line bg-bg shadow-2xl md:left-auto md:w-[420px]"
    >
      <header className="flex h-11 shrink-0 items-center gap-2 border-b border-line px-3">
        <h2 className="min-w-0 flex-1 truncate text-sm font-semibold text-fg">{title}</h2>
        <button type="button" className="rounded px-2 py-1 text-sm text-fg-dim hover:bg-bg-3 hover:text-fg" aria-label="Fechar chat" title="Fechar (Esc)" onClick={close}>
          ✕
        </button>
      </header>
      <div className="flex min-h-0 flex-1 flex-col">
        <ChatPanel key={openProjectId} projectId={openProjectId} />
      </div>
    </aside>
  );
}
