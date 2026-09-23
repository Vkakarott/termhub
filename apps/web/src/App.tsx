import { lazy, Suspense } from 'react';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { AuthProvider } from './lib/auth';
import { AnalyticsGate } from './components/AnalyticsGate';
import { ErrorBoundary } from './components/ErrorBoundary';
import { AppShell, FullScreenMessage, Layout } from './components/Layout';
import { ChatLayout } from './components/ChatLayout';
import { retryOnceOnImportFailure } from './lib/lazy-retry';
import { LoginPage } from './pages/LoginPage';
import { HomePage } from './pages/HomePage';
import { ProjectPage } from './pages/ProjectPage';
import { ChatPage } from './pages/ChatPage';
import { IntegrationsView } from './components/IntegrationsView';
import { MachinesPage } from './pages/MachinesPage';
import { SettingsPage } from './pages/SettingsPage';

// lazy so PixiJS stays out of the main bundle; the retry survives the chunk hashes a deploy changes
const OfficePage = lazy(retryOnceOnImportFailure(() => import('./pages/OfficePage').then((m) => ({ default: m.OfficePage }))));

/** The one lazy route: a failed import must show a way out, not unmount the app. */
function OfficeRoute() {
  return (
    <ErrorBoundary fallback={<RouteFailed />}>
      <Suspense fallback={<FullScreenMessage>Carregando…</FullScreenMessage>}>
        <OfficePage />
      </Suspense>
    </ErrorBoundary>
  );
}

function RouteFailed() {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center text-sm text-fg-muted">
      <span>Não foi possível carregar esta página.</span>
      <button className="rounded border border-line px-3 py-1 hover:bg-bg-3 hover:text-fg" onClick={() => location.reload()}>
        Recarregar
      </button>
    </div>
  );
}

export function App() {
  return (
    <BrowserRouter>
      <AuthProvider>
        <AnalyticsGate>
          <Routes>
            <Route path="/login" element={<LoginPage />} />
            <Route element={<AppShell />}>
              <Route element={<Layout />}>
                <Route path="/" element={<HomePage />} />
                <Route path="/ai" element={<HomePage />} />
                <Route path="/hardware" element={<HomePage />} />
                <Route path="/waitlist" element={<HomePage />} />
                <Route path="/integrations" element={<IntegrationsView />} />
                <Route path="/machines" element={<MachinesPage />} />
                <Route path="/settings" element={<SettingsPage />} />
                <Route path="/settings/:section" element={<SettingsPage />} />
                <Route path="/projects/:id" element={<ProjectPage />} />
                <Route path="/projects/:id/:section" element={<ProjectPage />} />
                <Route path="/office" element={<OfficeRoute />} />
                <Route path="/office/:machineId" element={<OfficeRoute />} />
              </Route>
              <Route element={<ChatLayout />}>
                <Route path="/chat" element={<ChatPage />} />
              </Route>
            </Route>
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </AnalyticsGate>
      </AuthProvider>
    </BrowserRouter>
  );
}
