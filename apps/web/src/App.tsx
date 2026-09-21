import { lazy, Suspense } from 'react';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { AuthProvider } from './lib/auth';
import { AnalyticsGate } from './components/AnalyticsGate';
import { AppShell, Layout } from './components/Layout';
import { ChatLayout } from './components/ChatLayout';
import { LoginPage } from './pages/LoginPage';
import { HomePage } from './pages/HomePage';
import { ProjectPage } from './pages/ProjectPage';
import { ChatPage } from './pages/ChatPage';
import { IntegrationsPage } from './pages/IntegrationsPage';
import { SettingsPage } from './pages/SettingsPage';

// SPIKE (throwaway): lazy so PixiJS stays out of the main bundle
const OfficeSpikePage = lazy(() => import('./pages/OfficeSpikePage').then((m) => ({ default: m.OfficeSpikePage })));

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
                <Route path="/spike/office" element={<Suspense fallback={null}><OfficeSpikePage /></Suspense>} />
                <Route path="/integrations" element={<IntegrationsPage />} />
                <Route path="/settings" element={<SettingsPage />} />
                <Route path="/settings/:section" element={<SettingsPage />} />
                <Route path="/projects/:id" element={<ProjectPage />} />
                <Route path="/projects/:id/:section" element={<ProjectPage />} />
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
