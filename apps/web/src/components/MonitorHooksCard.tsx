import { useEffect, useState } from 'react';
import { api, ApiError } from '../lib/api';
import type { Machine, MachineHooks } from '../lib/types';

/** Machine form: install / remove the monitor hooks (what feeds "Precisando de você"). */
export function MonitorHooksCard({ machine }: { machine: Machine }) {
  const [hooks, setHooks] = useState<MachineHooks | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    api.machines
      .hooks(machine.id)
      .then((h) => !cancelled && setHooks(h))
      .catch((e) => !cancelled && setError(e instanceof ApiError ? e.message : 'Erro ao consultar'));
    return () => {
      cancelled = true;
    };
  }, [machine.id]);

  const install = async () => {
    setBusy(true);
    setError(null);
    setNote(null);
    try {
      const r = await api.machines.installHooks(machine.id);
      setHooks({ installed_at: r.installed_at, hooks_url: r.hooks_url });
      setNote(`Claude Code: ${r.claude === 'installed' ? 'ok' : 'não encontrado'} · Codex: ${r.codex === 'installed' ? 'ok' : 'não encontrado'}. Vale para sessões abertas a partir de agora.`);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Erro ao instalar');
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!window.confirm('Remover os hooks do termhub desta máquina?')) return;
    setBusy(true);
    setError(null);
    setNote(null);
    try {
      await api.machines.removeHooks(machine.id);
      setHooks((h) => (h ? { ...h, installed_at: null } : h));
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Erro ao remover');
    } finally {
      setBusy(false);
    }
  };

  const installed = !!hooks?.installed_at;
  return (
    <div className="rounded-md border border-line bg-bg p-2 text-xs">
      <div className="flex items-center gap-2">
        <p className="font-medium text-fg-muted">Monitor das tabs</p>
        <span className="text-fg-dim">{hooks ? (installed ? `instalado em ${new Date(hooks.installed_at!).toLocaleString('pt-BR')}` : 'não instalado') : '…'}</span>
        <span className="ml-auto flex gap-1">
          {installed && (
            <button type="button" className="btn-ghost px-2 py-0.5" onClick={() => void remove()} disabled={busy}>
              Remover
            </button>
          )}
          <button type="button" className="btn-ghost px-2 py-0.5" onClick={() => void install()} disabled={busy || !hooks}>
            {busy ? '…' : installed ? 'Reinstalar' : 'Instalar'}
          </button>
        </span>
      </div>
      <p className="mt-1 text-fg-dim">
        Escreve <code className="font-mono">~/.termhub/bin/termhub-hook</code> e registra hooks no Claude Code (<code className="font-mono">~/.claude/settings.json</code>) e no Codex (
        <code className="font-mono">~/.codex/config.toml</code>) para avisar quando uma tab está esperando você. Só a pergunta da ferramenta é enviada, nunca o conteúdo do terminal.
      </p>
      {hooks && <p className="mt-1 truncate font-mono text-[10px] text-fg-dim" title={hooks.hooks_url}>→ {hooks.hooks_url}</p>}
      {note && <p className="mt-1 text-fg-muted">{note}</p>}
      {error && <p className="mt-1 text-danger">{error}</p>}
    </div>
  );
}
