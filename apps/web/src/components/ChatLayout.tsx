import { Link, Outlet } from 'react-router-dom';

/**
 * The chat's own full-screen shell: no sidebar, no menus — just a thin header with a way back
 * to the app and room for the page's own status text. It sits under `AppShell`, so the auth
 * guard, data/monitor/toast providers and the "precisando de você" toasts still apply here.
 */
export function ChatLayout() {
  return (
    <div className="flex h-[100dvh] flex-col overflow-hidden">
      <header className="flex h-11 shrink-0 items-center gap-3 border-b border-line px-3">
        <Link to="/" className="text-sm text-fg-dim hover:text-fg" aria-label="Voltar para o início" title="Voltar para o início">
          ← Voltar
        </Link>
      </header>
      <div className="min-h-0 flex-1">
        <Outlet />
      </div>
    </div>
  );
}
