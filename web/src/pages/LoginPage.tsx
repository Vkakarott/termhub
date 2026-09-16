import { useState, type FormEvent } from 'react';
import { Navigate, useSearchParams } from 'react-router-dom';
import { useAuth } from '../lib/auth';
import { ApiError } from '../lib/api';

const OAUTH_ERRORS: Record<string, string> = {
  google_denied: 'Login com Google cancelado.',
  state_mismatch: 'Sessão de login expirou. Tente novamente.',
  google_exchange: 'Falha ao validar o login com o Google.',
  email_not_allowed: 'Este e-mail do Google não está cadastrado no termhub.',
};

export function LoginPage() {
  const { user, loading, login, config } = useAuth();
  const [params] = useSearchParams();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(() => {
    const e = params.get('error');
    return e ? (OAUTH_ERRORS[e] ?? 'Falha no login.') : null;
  });
  const [busy, setBusy] = useState(false);

  if (loading) return null;
  if (user) return <Navigate to="/" replace />;

  const appMode = !config || config.modes.includes('app');

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await login(email, password);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Não foi possível entrar.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex h-full items-center justify-center p-4">
      <div className="w-full max-w-sm rounded-xl border border-line bg-bg-2 p-6 shadow-2xl">
        <h1 className="mb-1 text-lg font-semibold tracking-tight">
          <span className="text-accent">▮</span> termhub
        </h1>
        <p className="mb-6 text-sm text-fg-muted">Terminais das suas máquinas, no navegador.</p>

        {!appMode ? (
          <p className="text-sm text-fg-muted">
            Este servidor não usa login por senha. Acesse pelo endereço protegido pelo Cloudflare Access.
          </p>
        ) : (
          <form onSubmit={submit} className="space-y-3">
            <div>
              <label className="label" htmlFor="email">
                E-mail
              </label>
              <input id="email" className="input" type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} required autoFocus />
            </div>
            <div>
              <label className="label" htmlFor="password">
                Senha
              </label>
              <input id="password" className="input" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required />
            </div>
            {error && <p className="text-sm text-danger">{error}</p>}
            <button className="btn-primary w-full justify-center" type="submit" disabled={busy}>
              {busy ? 'Entrando…' : 'Entrar'}
            </button>
            {config?.google && (
              <>
                <div className="flex items-center gap-2 py-1 text-xs text-fg-dim">
                  <span className="h-px flex-1 bg-line" />
                  ou
                  <span className="h-px flex-1 bg-line" />
                </div>
                <a className="btn w-full justify-center border border-line text-fg hover:bg-bg-3" href="/api/auth/google">
                  <GoogleIcon /> Entrar com Google
                </a>
              </>
            )}
          </form>
        )}
      </div>
    </div>
  );
}

function GoogleIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 48 48" aria-hidden="true">
      <path fill="#EA4335" d="M24 9.5c3.5 0 6.6 1.2 9.1 3.6l6.8-6.8C35.8 2.4 30.3 0 24 0 14.6 0 6.5 5.4 2.6 13.3l7.9 6.1C12.4 13.6 17.7 9.5 24 9.5z" />
      <path fill="#4285F4" d="M46.5 24.5c0-1.6-.1-3.1-.4-4.5H24v8.5h12.7c-.5 2.8-2.2 5.2-4.6 6.8l7.4 5.7c4.3-4 6.9-9.9 6.9-16.5z" />
      <path fill="#FBBC05" d="M10.5 28.6c-.5-1.5-.8-3-.8-4.6s.3-3.1.8-4.6l-7.9-6.1C.9 16.6 0 20.2 0 24s.9 7.4 2.6 10.7l7.9-6.1z" />
      <path fill="#34A853" d="M24 48c6.3 0 11.6-2.1 15.5-5.7l-7.4-5.7c-2.1 1.4-4.8 2.2-8.1 2.2-6.3 0-11.6-4.1-13.5-9.8l-7.9 6.1C6.5 42.6 14.6 48 24 48z" />
    </svg>
  );
}
