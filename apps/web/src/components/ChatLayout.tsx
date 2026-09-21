import { useEffect } from 'react';
import { Link, Outlet } from 'react-router-dom';

/**
 * The chat's own full-screen shell: no sidebar, no menus — just a thin header with a way back
 * to the app and room for the page's own status text. It sits under `AppShell`, so the auth
 * guard, data/monitor/toast providers and the "precisando de você" toasts still apply here.
 *
 * The height is `100svh`, not `100dvh`: `dvh` grows as Safari's URL bar collapses, while `html`,
 * `body` and `#root` are sized to the layout viewport (`height: 100%`), so the two disagree by the
 * height of that bar and the document itself becomes scrollable — a page sliding under a chat that
 * is already scrolling its own thread. `svh` is the smallest the viewport gets, so this shell never
 * exceeds what the body was sized to.
 */
export function ChatLayout() {
  // The document itself must not scroll while the chat is open. Sizing the shell to the viewport is
  // not enough on iOS: a drag that starts on a child which cannot scroll — the message box, most of
  // all — is handed to the document, and the page pans under a conversation that is already
  // scrolling its own thread. A class on `body` (not a global rule) keeps every other route, and the
  // terminals in particular, exactly as they were.
  useEffect(() => {
    document.body.classList.add('chat-locked');
    return () => document.body.classList.remove('chat-locked');
  }, []);

  return (
    <div className="flex h-[100svh] flex-col overflow-hidden">
      <header className="flex h-11 shrink-0 items-center gap-3 border-b border-line px-3">
        <Link to="/" className="text-sm text-fg-dim hover:text-fg" aria-label="Voltar para o início" title="Voltar para o início">
          ← Voltar
        </Link>
        <h1 className="text-sm font-semibold text-fg">Chat</h1>
        {/* Which bundle this screen is running, so "it did not change on my phone" can be answered by
            reading it instead of guessing between a stale page and a fix that does not work. The
            version is what the person asked for; the commit is what actually tells two deploys apart,
            since the version has not moved since 0.1.0. */}
        <span className="ml-auto font-mono text-[10px] text-fg-dim" title="build">
          v{__APP_VERSION__} · {import.meta.env.VITE_BUILD_SHA || __BUILD_STAMP__}
        </span>
      </header>
      {/* `main`, like every sidebar route's own region (`Layout.tsx`): /chat is a full page too, and
       * a screen reader needs the landmark to skip the header. */}
      {/* A flex column, not a plain block: the page inside stretches to this region instead of
       * asking for `height: 100%` of it. A percentage height against a flex item that has no
       * explicit height is the case Safari does not resolve — the column collapsed to its content,
       * the thread stopped filling the screen, the box floated above a slab of empty space, and the
       * document became the thing that scrolled. */}
      <main className="flex min-h-0 flex-1 flex-col">
        <Outlet />
      </main>
    </div>
  );
}
