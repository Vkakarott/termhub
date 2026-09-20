import { useEffect, useRef, useState } from 'react';
import { api, ApiError } from '../lib/api';
import { useData } from '../lib/data';
import type { Machine } from '../lib/types';

export const POLL_MS = 3000;
const POLL_MAX_MS = 90_000;

type Versions = { current: string | null; latest: string | null; online: boolean; updateAvailable: boolean };

/** Machine form: the agent's version, the update button and the auto-update switch. */
export function AgentUpdateCard({ machine }: { machine: Machine }) {
  const { updateMachine, checkStatus } = useData();
  const [v, setV] = useState<Versions | null>(null);
  const [busy, setBusy] = useState(false);
  const [auto, setAuto] = useState(machine.agent_auto_update);
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);
  /** false once the card unmounts (form closed): stops a poll's in-flight tick from rescheduling. */
  const alive = useRef(true);

  const load = async (): Promise<Versions> => {
    const s = await api.machines.status(machine.id);
    const next = { current: s.agent_version ?? null, latest: s.latest_agent_version ?? null, online: s.online, updateAvailable: !!s.update_available };
    setV(next);
    return next;
  };

  useEffect(() => {
    let cancelled = false;
    alive.current = true;
    load().catch((e) => !cancelled && setError(e instanceof ApiError ? e.message : 'Erro ao consultar'));
    const all = timers.current;
    return () => {
      cancelled = true;
      alive.current = false;
      all.forEach(clearTimeout);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [machine.id]);

  /** After a service restart the agent reconnects with the new version; poll until it does (or give up). */
  const pollUntil = (target: string) => {
    const started = Date.now();
    const tick = async () => {
      let s: Versions | null = null;
      try {
        s = await load();
      } catch {
        /* offline while restarting: keep polling */
      }
      if (!alive.current) return;
      if (s && s.online && s.current === target) {
        setNote(`Agente atualizado para v${target}.`);
        setBusy(false);
        void checkStatus(machine.id);
        return;
      }
      if (Date.now() - started > POLL_MAX_MS) {
        setNote('Ainda reconectando… verifique o agente na máquina.');
        setBusy(false);
        return;
      }
      if (alive.current) timers.current.push(setTimeout(() => void tick(), POLL_MS));
    };
    if (alive.current) timers.current.push(setTimeout(() => void tick(), POLL_MS));
  };

  const update = async () => {
    if (!v?.latest) return;
    setBusy(true);
    setError(null);
    setNote(null);
    try {
      const r = await api.machines.updateAgent(machine.id);
      if (r.restarting) {
        setNote('Instalando… o agente reinicia e os terminais abertos reconectam.');
        pollUntil(v.latest);
      } else {
        setNote(`Instalado v${r.installed_version ?? v.latest}; reinicie o agente nesta máquina (termhub-agent run ou o serviço).`);
        setBusy(false);
      }
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Erro ao atualizar');
      setBusy(false);
    }
  };

  const toggleAuto = async (next: boolean) => {
    setAuto(next);
    try {
      await updateMachine(machine.id, { agent_auto_update: next });
    } catch (e) {
      setAuto(!next);
      setError(e instanceof ApiError ? e.message : 'Erro ao salvar');
    }
  };

  const summary = !v ? '…' : !v.current ? 'versão desconhecida' : v.updateAvailable && v.latest ? `v${v.current} · v${v.latest} disponível` : v.latest ? `v${v.current} · atualizado` : `v${v.current}`;

  return (
    <div className="rounded-md border border-line bg-bg p-2 text-xs">
      <div className="flex items-center gap-2">
        <p className="font-medium text-fg-muted">Agente</p>
        <span className="text-fg-dim">{summary}</span>
        {v?.updateAvailable && (
          <span className="ml-auto">
            <button type="button" className="btn-ghost px-2 py-0.5" onClick={() => void update()} disabled={busy || !v.online}>
              {busy ? '…' : 'Atualizar'}
            </button>
          </span>
        )}
      </div>
      <label className="mt-1 flex items-center gap-2 text-fg-dim">
        <input type="checkbox" checked={auto} onChange={(e) => void toggleAuto(e.target.checked)} />
        Atualizar automaticamente quando ociosa
      </label>
      <p className="mt-1 text-fg-dim">Sem terminais abertos, o servidor instala novas versões do agente sozinho. Terminais abertos reconectam automaticamente depois da atualização.</p>
      {note && <p className="mt-1 text-fg-muted">{note}</p>}
      {error && <p className="mt-1 text-danger">{error}</p>}
    </div>
  );
}
