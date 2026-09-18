import { useEffect, useState } from 'react';
import { api, ApiError } from '../lib/api';
import type { WaitlistEntry } from '../lib/types';
import { ConfirmDialog } from './Modal';

/**
 * Home "Waitlist" tab: sign-ups from the landing page's Cloud section.
 * Shown only to roles granted waitlist:read (see HomePage).
 */

function csv(entries: WaitlistEntry[]): string {
  const cols = ['created_at', 'first_name', 'last_name', 'email', 'phone', 'linkedin', 'github', 'locale'] as const;
  const esc = (v: string | null) => `"${(v ?? '').replace(/"/g, '""')}"`;
  return [cols.join(','), ...entries.map((e) => cols.map((c) => esc(e[c])).join(','))].join('\n');
}

export function WaitlistView() {
  const [entries, setEntries] = useState<WaitlistEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<WaitlistEntry | null>(null);
  const [filter, setFilter] = useState('');

  const load = () =>
    api.waitlist
      .list()
      .then((r) => {
        setEntries(r.entries);
        setError(null);
      })
      .catch((err) => setError(err instanceof ApiError ? err.message : 'Erro ao carregar a waitlist'));

  useEffect(() => {
    void load();
  }, []);

  const visible = (entries ?? []).filter((e) => {
    const q = filter.trim().toLowerCase();
    return !q || `${e.first_name} ${e.last_name} ${e.email} ${e.phone}`.toLowerCase().includes(q);
  });

  const download = () => {
    const blob = new Blob([csv(entries ?? [])], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `termhub-waitlist-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  return (
    <div>
      <div className="mb-5 flex items-end gap-4">
        <div>
          <h1 className="text-lg font-semibold">Waitlist do Cloud</h1>
          <p className="text-sm text-fg-muted">{entries ? `${entries.length} inscrito(s) pela landing page` : 'Carregando…'}</p>
        </div>
        <span className="ml-auto flex items-center gap-2">
          <input className="input w-48 py-1 text-xs" placeholder="filtrar…" value={filter} onChange={(e) => setFilter(e.target.value)} />
          <button className="btn-ghost text-xs" onClick={download} disabled={!entries?.length}>
            ↓ CSV
          </button>
          <button className="btn-ghost text-xs" onClick={() => void load()} title="Recarregar">
            ↻
          </button>
        </span>
      </div>
      {error && <p className="mb-3 text-sm text-danger">{error}</p>}
      {entries && entries.length === 0 && <p className="text-sm text-fg-dim">Ninguém ainda. O formulário fica na seção Cloud da landing page.</p>}
      {visible.length > 0 && (
        <div className="overflow-x-auto rounded-lg border border-line bg-bg-2">
          <table className="w-full text-sm">
            <thead className="text-left text-[11px] uppercase tracking-wide text-fg-dim">
              <tr className="border-b border-line">
                <th className="px-3 py-2">Quando</th>
                <th className="px-3 py-2">Nome</th>
                <th className="px-3 py-2">E-mail</th>
                <th className="px-3 py-2">Telefone</th>
                <th className="px-3 py-2">Links</th>
                <th className="px-3 py-2">Idioma</th>
                <th className="px-3 py-2" />
              </tr>
            </thead>
            <tbody>
              {visible.map((e) => (
                <tr key={e.id} className="border-b border-line last:border-0 hover:bg-bg-3">
                  <td className="whitespace-nowrap px-3 py-2 text-xs text-fg-dim">{new Date(e.created_at).toLocaleString('pt-BR')}</td>
                  <td className="px-3 py-2">
                    {e.first_name} {e.last_name}
                  </td>
                  <td className="px-3 py-2">
                    <a href={`mailto:${e.email}`} className="hover:underline">
                      {e.email}
                    </a>
                  </td>
                  <td className="whitespace-nowrap px-3 py-2 font-mono text-xs">{e.phone}</td>
                  <td className="px-3 py-2 text-xs">
                    {e.linkedin && (
                      <a href={e.linkedin} target="_blank" rel="noreferrer" className="mr-2 text-accent hover:underline">
                        LinkedIn
                      </a>
                    )}
                    {e.github && (
                      <a href={e.github} target="_blank" rel="noreferrer" className="text-accent hover:underline">
                        GitHub
                      </a>
                    )}
                  </td>
                  <td className="px-3 py-2 text-xs uppercase text-fg-dim">{e.locale}</td>
                  <td className="px-3 py-2 text-right">
                    <button className="rounded px-1 text-xs text-fg-dim hover:bg-bg-4 hover:text-danger" title="Remover" onClick={() => setDeleting(e)}>
                      ✕
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <ConfirmDialog
        open={!!deleting}
        title="Remover da waitlist"
        message={
          <>
            Remover <strong>{deleting?.email}</strong> da lista?
          </>
        }
        confirmLabel="Remover"
        danger
        onCancel={() => setDeleting(null)}
        onConfirm={async () => {
          if (!deleting) return;
          try {
            await api.waitlist.remove(deleting.id);
            setEntries((l) => (l ?? []).filter((x) => x.id !== deleting.id));
          } catch (err) {
            setError(err instanceof ApiError ? err.message : 'Erro ao remover');
          }
          setDeleting(null);
        }}
      />
    </div>
  );
}
