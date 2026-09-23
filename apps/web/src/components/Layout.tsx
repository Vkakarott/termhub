import { useEffect, useState } from 'react';
import { Navigate, NavLink, Outlet, useLocation } from 'react-router-dom';
import { useAuth } from '../lib/auth';
import { DataProvider } from '../lib/data';
import { FocusProvider, useFocusMode } from '../lib/focus';
import { MonitorProvider } from '../lib/monitor';
import { ProjectChatProvider } from '../lib/project-chat';
import { ProjectGroupsProvider } from '../lib/project-groups';
import { isSettingsPath, useSettingsExit } from '../lib/settings-nav';
import { ToastProvider, Toaster } from '../lib/toast';
import { ChatDrawer } from './chat/ChatDrawer';
import { NeedsYouToasts } from './NeedsYouToasts';
import { SettingsSidebar } from './SettingsSidebar';
import { Sidebar } from './Sidebar';
import { NicknamePrompt } from './NicknamePrompt';

const SIDEBAR_KEY = 'termhub:sidebar-collapsed';

/**
 * Everything signed-in routes need that isn't visual chrome: the auth guard, the
 * data/monitor/toast providers and the "precisando de você" overlays. Both the sidebar layout
 * (`Layout`) and the chat's full-screen layout (`ChatLayout`) render under this, so a chat page
 * still receives monitor pushes and toasts.
 */
export function AppShell() {
  const { user, loading } = useAuth();

  if (loading) return <FullScreenMessage>Carregando…</FullScreenMessage>;
  if (!user) return <Navigate to="/login" replace />;
  return (
    <DataProvider>
      <MonitorProvider>
        <ProjectGroupsProvider>
          <ToastProvider>
            <Outlet />
            <NeedsYouToasts />
            <NicknamePrompt />
            <Toaster />
          </ToastProvider>
        </ProjectGroupsProvider>
      </MonitorProvider>
    </DataProvider>
  );
}

export function Layout() {
  const [collapsed, setCollapsed] = useState(() => localStorage.getItem(SIDEBAR_KEY) === '1');
  useEffect(() => {
    localStorage.setItem(SIDEBAR_KEY, collapsed ? '1' : '0');
  }, [collapsed]);
  // remembers the last page outside settings and answers Esc under settings (lib/settings-nav)
  const leaveSettings = useSettingsExit();

  return (
    <FocusProvider>
      <ProjectChatProvider>
        <div className="flex h-full">
          <Chrome collapsed={collapsed} setCollapsed={setCollapsed} onLeaveSettings={leaveSettings} />
          <main className="relative min-w-0 flex-1">
            <Outlet />
          </main>
        </div>
        <ChatDrawer />
      </ProjectChatProvider>
    </FocusProvider>
  );
}

/**
 * The sidebar slot: Configurações' own sidebar under /settings, the projects sidebar elsewhere, the
 * rail when collapsed. Hidden entirely while the page is in focus mode — only `/office` has one (lib/focus).
 */
export function Chrome({ collapsed, setCollapsed, onLeaveSettings }: { collapsed: boolean; setCollapsed: (v: boolean) => void; onLeaveSettings: () => void }) {
  const { focus } = useFocusMode();
  const { pathname } = useLocation();
  if (focus) return null;
  if (collapsed) return <SidebarRail onExpand={() => setCollapsed(false)} />;
  if (isSettingsPath(pathname)) return <SettingsSidebar onBack={onLeaveSettings} onCollapse={() => setCollapsed(true)} />;
  return <Sidebar onCollapse={() => setCollapsed(true)} />;
}

/** Sidebar recolhida: uma faixa estreita com o logo e o botão de expandir (o terminal ganha o espaço). */
function SidebarRail({ onExpand }: { onExpand: () => void }) {
  return (
    <aside className="flex h-full w-9 shrink-0 flex-col items-center border-r border-line bg-bg-2">
      <NavLink to="/" className="flex h-11 w-full items-center justify-center border-b border-line text-sm font-semibold text-accent" title="termhub — início">
        ▮
      </NavLink>
      <button className="mt-1 rounded px-2 py-1 text-xs text-fg-dim hover:bg-bg-3 hover:text-fg" onClick={onExpand} title="Mostrar sidebar" aria-label="Mostrar sidebar">
        »
      </button>
    </aside>
  );
}

export function FullScreenMessage({ children }: { children: React.ReactNode }) {
  return <div className="flex h-full items-center justify-center text-sm text-fg-muted">{children}</div>;
}
