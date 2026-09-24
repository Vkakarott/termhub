import { useEffect, useRef, useState } from 'react';
import { Navigate, Outlet, useLocation } from 'react-router-dom';
import { useAuth } from '../lib/auth';
import { DataProvider } from '../lib/data';
import { FocusProvider, useFocusMode } from '../lib/focus';
import { MonitorProvider } from '../lib/monitor';
import { ProjectChatProvider } from '../lib/project-chat';
import { ProjectGroupsProvider } from '../lib/project-groups';
import { isSettingsPath, useSettingsExit } from '../lib/settings-nav';
import { ToastProvider, Toaster } from '../lib/toast';
import { ChatDrawer } from './chat/ChatDrawer';
import { DeviceRequestBanner } from './DeviceRequestBanner';
import { NeedsYouToasts } from './NeedsYouToasts';
import { SettingsSidebar } from './SettingsSidebar';
import { SidebarRail } from './SidebarRail';
import { Sidebar } from './Sidebar';
import { NicknamePrompt } from './NicknamePrompt';
import { useEscapeLayer } from './Modal';

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
            <DeviceRequestBanner />
            <Outlet />
          </main>
        </div>
        <ChatDrawer />
      </ProjectChatProvider>
    </FocusProvider>
  );
}

/** Below Tailwind's `md` breakpoint a 16rem sidebar leaves too little room for the page. */
const NARROW_QUERY = '(max-width: 767px)';

function narrowNow(): boolean {
  return typeof window.matchMedia === 'function' && window.matchMedia(NARROW_QUERY).matches;
}

/** Whether the window is phone-sized, following resizes; false where matchMedia is missing (jsdom). */
function useNarrowWindow(): boolean {
  const [narrow, setNarrow] = useState(narrowNow);
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return;
    const mq = window.matchMedia(NARROW_QUERY);
    const update = () => setNarrow(mq.matches);
    update();
    mq.addEventListener?.('change', update);
    return () => mq.removeEventListener?.('change', update);
  }, []);
  return narrow;
}

/**
 * The sidebar slot: Configurações' own sidebar under /settings, the projects sidebar elsewhere, the
 * rail when collapsed. Hidden entirely while the page is in focus mode — only `/office` has one (lib/focus).
 * On a narrow window the rail is always what sits in the page, whatever the stored preference, and
 * expanding it opens the sidebar as an overlay above the content (backdrop, Esc and navigating close
 * it) instead of pushing the content aside; the stored preference is left for wide windows.
 */
export function Chrome({ collapsed, setCollapsed, onLeaveSettings }: { collapsed: boolean; setCollapsed: (v: boolean) => void; onLeaveSettings: () => void }) {
  const { focus } = useFocusMode();
  const { pathname } = useLocation();
  const settings = isSettingsPath(pathname);
  const narrow = useNarrowWindow();
  const [overlay, setOverlay] = useState(false);
  const closeOverlay = () => setOverlay(false);
  useEffect(() => setOverlay(false), [pathname, narrow]);
  useEscapeLayer(narrow && overlay, closeOverlay);
  useSwapFocus(settings);
  if (focus) return null;
  const mode = settings ? 'settings' : 'main';
  if (narrow) {
    return (
      <>
        <SidebarRail mode={mode} onExpand={() => setOverlay(true)} onBack={onLeaveSettings} />
        {overlay && (
          <>
            <div data-testid="sidebar-backdrop" aria-hidden="true" className="fixed inset-0 z-40 bg-black/50" onClick={closeOverlay} />
            <div role="dialog" aria-modal="true" aria-label="Menu" className="fixed inset-y-0 left-0 z-50 flex max-w-[85vw] shadow-2xl">
              {settings ? <SettingsSidebar onBack={onLeaveSettings} onCollapse={closeOverlay} /> : <Sidebar onCollapse={closeOverlay} />}
            </div>
          </>
        )}
      </>
    );
  }
  if (collapsed) return <SidebarRail mode={mode} onExpand={() => setCollapsed(false)} onBack={onLeaveSettings} />;
  if (settings) return <SettingsSidebar onBack={onLeaveSettings} onCollapse={() => setCollapsed(true)} />;
  return <Sidebar onCollapse={() => setCollapsed(true)} />;
}

/**
 * Swapping the sidebar unmounts the control that was pressed (the profile row, Voltar), dropping focus
 * on <body>. Hand it to the new sidebar's counterpart: the way back when entering settings, the
 * profile button when leaving. Only when focus was actually lost, and never on the first render, so a
 * page opened straight on settings or a link pressed in the page keeps its focus.
 */
function useSwapFocus(settings: boolean) {
  const previous = useRef(settings);
  useEffect(() => {
    if (previous.current === settings) return;
    previous.current = settings;
    const active = document.activeElement;
    if (active && active !== document.body && active.isConnected) return;
    document.querySelector<HTMLElement>(`[data-chrome-focus="${settings ? 'settings-back' : 'profile'}"]`)?.focus();
  }, [settings]);
}

export function FullScreenMessage({ children }: { children: React.ReactNode }) {
  return <div className="flex h-full items-center justify-center text-sm text-fg-muted">{children}</div>;
}
