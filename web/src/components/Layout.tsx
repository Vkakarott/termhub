import { Navigate, Outlet } from 'react-router-dom';
import { useAuth } from '../lib/auth';
import { DataProvider } from '../lib/data';
import { Sidebar } from './Sidebar';

export function Layout() {
  const { user, loading } = useAuth();
  if (loading) return <FullScreenMessage>Carregando…</FullScreenMessage>;
  if (!user) return <Navigate to="/login" replace />;
  return (
    <DataProvider>
      <div className="flex h-full">
        <Sidebar />
        <main className="relative min-w-0 flex-1">
          <Outlet />
        </main>
      </div>
    </DataProvider>
  );
}

export function FullScreenMessage({ children }: { children: React.ReactNode }) {
  return <div className="flex h-full items-center justify-center text-sm text-fg-muted">{children}</div>;
}
