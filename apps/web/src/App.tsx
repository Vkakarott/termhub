import { lazy, Suspense } from 'react';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { AuthProvider } from './lib/auth';
import { AnalyticsGate } from './components/AnalyticsGate';
import { Layout } from './components/Layout';
import { LoginPage } from './pages/LoginPage';
import { HomePage } from './pages/HomePage';
import { ProjectPage } from './pages/ProjectPage';
import { ChatPage } from './pages/ChatPage';
import { IntegrationsPage } from './pages/IntegrationsPage';
import { SettingsPage } from './pages/SettingsPage';

// lazy so PixiJS stays out of the main bundle
const OfficePage = lazy(() => import('./pages/OfficePage').then((m) => ({ default: m.OfficePage })));

export function App() {
  return (
    <BrowserRouter>
      <AuthProvider>
        <AnalyticsGate>
          <Routes>
            <Route path="/login" element={<LoginPage />} />
            <Route element={<Layout />}>
              <Route path="/" element={<HomePage />} />
              <Route path="/ai" element={<HomePage />} />
              <Route path="/hardware" element={<HomePage />} />
              <Route path="/waitlist" element={<HomePage />} />
              <Route path="/chat" element={<ChatPage />} />
              <Route path="/integrations" element={<IntegrationsPage />} />
              <Route path="/settings" element={<SettingsPage />} />
              <Route path="/settings/:section" element={<SettingsPage />} />
              <Route path="/projects/:id" element={<ProjectPage />} />
              <Route path="/projects/:id/:section" element={<ProjectPage />} />
              <Route path="/office" element={<Suspense fallback={null}><OfficePage /></Suspense>} />
              <Route path="/office/:machineId" element={<Suspense fallback={null}><OfficePage /></Suspense>} />
            </Route>
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </AnalyticsGate>
      </AuthProvider>
    </BrowserRouter>
  );
}
