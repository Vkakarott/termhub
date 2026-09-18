import { useCallback, useEffect, useRef, useState } from 'react';
import { api, ApiError } from '../lib/api';
import { useData } from '../lib/data';
import type { HardwareSnapshot } from '../lib/types';

/**
 * Home "Hardware" tab: live CPU / memory / disks / temps / GPU / top processes of a machine.
 * Shown only to roles granted hardware:read (see HomePage).
 */

const POLL_MS = 5000;
const MACHINE_KEY = 'termhub:hardware-machine';

function gb(kb: number | null | undefined): string {
  if (kb == null) return '—';
  const g = kb / 1048576;
  if (g >= 1000) return `${(g / 1024).toFixed(2)} TB`;
  if (g >= 10) return `${g.toFixed(0)} GB`;
  if (g >= 1) return `${g.toFixed(1)} GB`;
  return `${Math.round(kb / 1024)} MB`;
}

function uptime(s: number | null): string {
  if (s == null) return '—';
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  return d > 0 ? `${d} d ${h} h` : h > 0 ? `${h} h ${m} min` : `${m} min`;
}

function tone(pct: number | null): 'ok' | 'warn' | 'danger' | 'none' {
  if (pct == null) return 'none';
  if (pct >= 90) return 'danger';
  if (pct >= 75) return 'warn';
  return 'ok';
}
const BAR: Record<ReturnType<typeof tone>, string> = { ok: 'bg-ok', warn: 'bg-warn', danger: 'bg-danger', none: 'bg-bg-4' };
const TEXT: Record<ReturnType<typeof tone>, string> = { ok: 'text-fg', warn: 'text-warn', danger: 'text-danger', none: 'text-fg-dim' };

/** Thin meter with the value written out: color marks state, the number carries the reading. */
function Meter({ pct, label, detail }: { pct: number | null; label: string; detail?: string }) {
  const t = tone(pct);
  return (
    <div>
      <div className="mb-1 flex items-baseline justify-between text-xs">
        <span className="text-fg-muted">{label}</span>
        <span className="tabular-nums">
          <span className={TEXT[t]}>{pct == null ? '—' : `${Math.round(pct)}%`}</span>
          {detail && <span className="text-fg-dim"> · {detail}</span>}
        </span>
      </div>
      <div className="h-1.5 overflow-hidden rounded-full bg-bg-4">
        <div className={`h-full rounded-full transition-[width] ${BAR[t]}`} style={{ width: `${pct == null ? 0 : Math.min(100, Math.max(1, pct))}%` }} />
      </div>
    </div>
  );
}

function Tile({ title, children, className = '' }: { title: string; children: React.ReactNode; className?: string }) {
  return (
    <section className={`rounded-lg border border-line bg-bg-2 p-4 ${className}`}>
      <h2 className="mb-3 text-[11px] font-medium uppercase tracking-wide text-fg-dim">{title}</h2>
      {children}
    </section>
  );
}

export function HardwareView() {
  const { machines, statuses } = useData();
  const [machineId, setMachineId] = useState<string>(() => {
    try {
      return localStorage.getItem(MACHINE_KEY) ?? '';
    } catch {
      return '';
    }
  });
  const [snap, setSnap] = useState<HardwareSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const inflight = useRef(false);

  // default: the termhub host (registered as host.docker.internal) or the first machine
  useEffect(() => {
    if (machineId && machines.some((m) => m.id === machineId)) return;
    const def = machines.find((m) => m.host === 'host.docker.internal') ?? machines[0];
    if (def) setMachineId(def.id);
  }, [machines, machineId]);

  const load = useCallback(async () => {
    if (!machineId || inflight.current) return;
    inflight.current = true;
    setLoading(true);
    try {
      const r = await api.machines.hardware(machineId);
      setSnap(r.hardware);
      setError(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Erro ao coletar o hardware');
    } finally {
      inflight.current = false;
      setLoading(false);
    }
  }, [machineId]);

  useEffect(() => {
    if (!machineId) return;
    try {
      localStorage.setItem(MACHINE_KEY, machineId);
    } catch {
      /* ignore */
    }
    setSnap(null);
    setError(null);
    void load();
    const tick = () => {
      if (document.visibilityState === 'visible') void load();
    };
    const id = window.setInterval(tick, POLL_MS);
    document.addEventListener('visibilitychange', tick);
    return () => {
      window.clearInterval(id);
      document.removeEventListener('visibilitychange', tick);
    };
  }, [machineId, load]);

  const machine = machines.find((m) => m.id === machineId);
  const memPct = snap?.mem_total_kb && snap.mem_used_kb != null ? (snap.mem_used_kb / snap.mem_total_kb) * 100 : null;
  const swapPct = snap?.swap_total_kb ? ((snap.swap_used_kb ?? 0) / snap.swap_total_kb) * 100 : null;
  const loadPct = snap?.load && snap.ncpu ? (snap.load[0] / snap.ncpu) * 100 : null;

  return (
    <div>
      <div className="mb-5 flex items-end gap-4">
        <div>
          <h1 className="text-lg font-semibold">Hardware</h1>
          <p className="text-sm text-fg-muted">
            {snap ? (
              <>
                {snap.hostname ?? machine?.name} · {snap.cpu_model ?? 'CPU ?'} · {snap.ncpu ?? '?'} núcleos · ligado há {uptime(snap.uptime_s)}
              </>
            ) : (
              'Uso de CPU, memória, discos e processos, atualizado a cada 5 s.'
            )}
          </p>
        </div>
        <span className="ml-auto flex items-center gap-2">
          {loading && <span className="text-xs text-fg-dim">atualizando…</span>}
          <select className="input w-auto py-1 text-xs" value={machineId} onChange={(e) => setMachineId(e.target.value)}>
            {machines.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name}
                {statuses[m.id] === 'offline' ? ' (offline)' : ''}
              </option>
            ))}
          </select>
        </span>
      </div>

      {error && <p className="mb-3 rounded border border-danger/40 bg-danger/10 p-2 text-sm text-danger">{error}</p>}
      {!snap && !error && <p className="text-sm text-fg-dim">Coletando…</p>}

      {snap && (
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
          <Tile title="CPU">
            <div className="space-y-3">
              <Meter pct={snap.cpu_pct} label="uso" />
              <Meter pct={loadPct} label="carga 1 min" detail={snap.load ? `${snap.load[0].toFixed(2)} · 5 min ${snap.load[1].toFixed(2)} · 15 min ${snap.load[2].toFixed(2)}` : undefined} />
            </div>
          </Tile>
          <Tile title="Memória">
            <div className="space-y-3">
              <Meter pct={memPct} label="RAM" detail={`${gb(snap.mem_used_kb)} de ${gb(snap.mem_total_kb)}`} />
              <Meter pct={swapPct} label="swap" detail={snap.swap_total_kb ? `${gb(snap.swap_used_kb)} de ${gb(snap.swap_total_kb)}` : 'sem swap'} />
            </div>
          </Tile>
          <Tile title="Temperaturas">
            {snap.temps.length === 0 && snap.gpus.length === 0 ? (
              <p className="text-xs text-fg-dim">{snap.os === 'macos' ? 'O macOS não expõe sensores sem ferramentas extras.' : 'Nenhum sensor encontrado.'}</p>
            ) : (
              <ul className="flex flex-wrap gap-1.5">
                {snap.temps.map((t, i) => (
                  <li key={`${t.label}-${i}`} className="rounded bg-bg-3 px-2 py-1 text-xs">
                    <span className="text-fg-muted">{t.label}</span> <span className={`tabular-nums ${t.c >= 85 ? 'text-danger' : t.c >= 70 ? 'text-warn' : 'text-fg'}`}>{Math.round(t.c)}°C</span>
                  </li>
                ))}
              </ul>
            )}
          </Tile>
          {snap.gpus.length > 0 && (
            <Tile title="GPU">
              <ul className="space-y-3">
                {snap.gpus.map((g, i) => (
                  <li key={i} className="space-y-2">
                    <p className="text-xs text-fg">{g.name}</p>
                    <Meter pct={g.utilization} label="uso" detail={g.temp_c != null ? `${g.temp_c}°C` : undefined} />
                    {g.mem_total_mb ? <Meter pct={((g.mem_used_mb ?? 0) / g.mem_total_mb) * 100} label="VRAM" detail={`${g.mem_used_mb} de ${g.mem_total_mb} MB`} /> : null}
                  </li>
                ))}
              </ul>
            </Tile>
          )}
          <Tile title="Discos" className="md:col-span-2 xl:col-span-2">
            {snap.disks.length === 0 ? (
              <p className="text-xs text-fg-dim">Nenhum disco encontrado.</p>
            ) : (
              <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                {snap.disks.map((d) => (
                  <li key={d.mount} title={d.source}>
                    <Meter pct={(d.used_kb / d.size_kb) * 100} label={d.mount} detail={`${gb(d.avail_kb)} livres de ${gb(d.size_kb)}`} />
                  </li>
                ))}
              </ul>
            )}
          </Tile>
          <Tile title="Processos (por CPU)">
            {snap.processes.length === 0 ? (
              <p className="text-xs text-fg-dim">—</p>
            ) : (
              <table className="w-full text-xs">
                <tbody>
                  {snap.processes.map((p, i) => (
                    <tr key={i} className="border-t border-line first:border-0">
                      <td className="max-w-0 truncate py-1 pr-2 font-mono" title={p.command}>
                        {p.command}
                      </td>
                      <td className="w-14 py-1 text-right tabular-nums">{p.cpu.toFixed(1)}%</td>
                      <td className="w-16 py-1 text-right tabular-nums text-fg-dim">{p.mem.toFixed(1)}% mem</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </Tile>
        </div>
      )}
    </div>
  );
}
