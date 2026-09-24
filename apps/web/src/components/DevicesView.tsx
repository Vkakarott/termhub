import { useCallback, useEffect, useMemo, useState, type KeyboardEvent } from 'react';
import { api, ApiError } from '../lib/api';
import { useAuth } from '../lib/auth';
import type { Device, DeviceEventView, DeviceRequestView } from '../lib/types';
import { ConfirmDialog } from './Modal';

/** Same ceiling the server enforces (mobile/enrolment.ts's DEVICE_LIMIT, 409 "Revogue um aparelho
 *  antes"): Aprovar is disabled here too, instead of always waiting for that round-trip. */
const MAX_DEVICES = 5;

/** DeviceRequestBanner listens for this to refresh its own summary right after a decision here. */
const DEVICES_CHANGED_EVENT = 'termhub:devices-changed';

const fmtDate = (iso: string) => new Date(iso).toLocaleDateString('pt-BR');
const fmtTime = (iso: string) => new Date(iso).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });

function placeOf(r: DeviceRequestView): string {
  return [r.city, r.country].filter(Boolean).join(', ') || r.ip;
}

function situationLabel(d: Device, now = new Date()): string {
  if (d.status === 'active') {
    if (d.pin_locked_until && new Date(d.pin_locked_until) > now) return `bloqueado por PIN até ${fmtTime(d.pin_locked_until)}`;
    return 'ativo';
  }
  return d.revoked_reason === 'pin_bruteforce' ? 'revogado (tentativas de PIN)' : 'revogado';
}

function notifyDevicesChanged(): void {
  window.dispatchEvent(new Event(DEVICES_CHANGED_EVENT));
}

/**
 * Settings → Aparelhos (spec §10.1): pending phone requests waiting on the code check, the enrolled
 * devices themselves and the activity trail. The signed-in user's own phones only — same rule as the
 * server routes this talks to.
 */
export function DevicesView() {
  const { can } = useAuth();
  const [requests, setRequests] = useState<DeviceRequestView[] | null>(null);
  const [devices, setDevices] = useState<Device[] | null>(null);
  const [events, setEvents] = useState<DeviceEventView[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [approving, setApproving] = useState<DeviceRequestView | null>(null);
  const [revoking, setRevoking] = useState<Device | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editValue, setEditValue] = useState('');

  const load = useCallback(async () => {
    setError(null);
    try {
      const [r, d, e] = await Promise.all([api.devices.requests(), api.devices.list(), api.devices.events()]);
      setRequests(r.requests);
      setDevices(d.devices);
      setEvents(e.events);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Erro ao carregar aparelhos');
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const activeCount = useMemo(() => (devices ?? []).filter((d) => d.status === 'active').length, [devices]);
  const atLimit = activeCount >= MAX_DEVICES;

  const deny = async (r: DeviceRequestView) => {
    setError(null);
    try {
      await api.devices.deny(r.id);
      setRequests((list) => (list ?? []).filter((x) => x.id !== r.id));
      notifyDevicesChanged();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Erro ao recusar o pedido');
    }
  };

  const confirmApprove = async () => {
    const r = approving;
    setApproving(null);
    if (!r) return;
    setError(null);
    try {
      await api.devices.approve(r.id);
      setRequests((list) => (list ?? []).filter((x) => x.id !== r.id));
      notifyDevicesChanged();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Erro ao aprovar o pedido');
    }
  };

  const confirmRevoke = async () => {
    const d = revoking;
    setRevoking(null);
    if (!d) return;
    setError(null);
    try {
      const r = await api.devices.revoke(d.id);
      setDevices((list) => (list ?? []).map((x) => (x.id === d.id ? r.device : x)));
      notifyDevicesChanged();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Erro ao revogar o aparelho');
    }
  };

  const startRename = (d: Device) => {
    setEditingId(d.id);
    setEditValue(d.name);
  };

  const submitRename = async (d: Device) => {
    const name = editValue.trim();
    setEditingId(null);
    if (!name || name === d.name) return;
    setError(null);
    try {
      const r = await api.devices.rename(d.id, name);
      setDevices((list) => (list ?? []).map((x) => (x.id === d.id ? r.device : x)));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Erro ao renomear o aparelho');
    }
  };

  const onNameKeyDown = (e: KeyboardEvent<HTMLInputElement>, d: Device) => {
    if (e.key === 'Enter') void submitRename(d);
    else if (e.key === 'Escape') setEditingId(null);
  };

  const loading = requests === null || devices === null || events === null;
  const empty = !loading && requests.length === 0 && devices.length === 0;

  return (
    <div className="max-w-4xl space-y-6">
      {error && <p className="text-sm text-danger">{error}</p>}

      {loading ? (
        <p className="text-sm text-fg-dim">Carregando…</p>
      ) : empty ? (
        <p className="text-sm text-fg-dim">Instale o app termhub no celular e entre com seu e-mail. O pedido de acesso aparece aqui.</p>
      ) : (
        <>
          {requests.length > 0 && (
            <section className="space-y-3">
              <h2 className="text-sm font-semibold">Pedidos de acesso</h2>
              <ul className="space-y-3">
                {requests.map((r) => (
                  <li key={r.id} className="rounded-lg border border-line bg-bg-2 p-4">
                    <p className="text-xs text-fg-dim">
                      {r.model} · {placeOf(r)}
                    </p>
                    <code className="font-mono text-2xl tracking-widest">{r.verification_code}</code>
                    <p className="mt-1 text-sm text-fg-muted">Se você não pediu isso, recuse.</p>
                    {atLimit && <p className="mt-1 text-xs text-danger">Revogue um aparelho antes</p>}
                    <div className="mt-2 flex gap-2">
                      {can('devices', 'update') && (
                        <button className="btn-ghost" onClick={() => void deny(r)}>
                          Recusar
                        </button>
                      )}
                      {can('devices', 'update') && (
                        <button className="btn-primary" disabled={atLimit} onClick={() => setApproving(r)}>
                          Aprovar
                        </button>
                      )}
                    </div>
                  </li>
                ))}
              </ul>
            </section>
          )}

          <section className="space-y-3">
            <h2 className="text-sm font-semibold">Aparelhos</h2>
            {devices.length === 0 ? (
              <p className="text-sm text-fg-dim">Nenhum aparelho ainda.</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="text-left text-xs text-fg-dim">
                    <tr>
                      <th className="py-1 pr-3 font-normal">Nome</th>
                      <th className="py-1 pr-3 font-normal">Modelo</th>
                      <th className="py-1 pr-3 font-normal">Adicionado</th>
                      <th className="py-1 pr-3 font-normal">Visto por último</th>
                      <th className="py-1 pr-3 font-normal">Situação</th>
                      <th className="py-1 font-normal" />
                    </tr>
                  </thead>
                  <tbody>
                    {devices.map((d) => (
                      <tr key={d.id} className={`border-t border-line ${d.status === 'active' ? '' : 'text-fg-dim'}`}>
                        <td className="py-1.5 pr-3">
                          {editingId === d.id ? (
                            <input
                              className="input py-0.5"
                              value={editValue}
                              autoFocus
                              onChange={(e) => setEditValue(e.target.value)}
                              onKeyDown={(e) => onNameKeyDown(e, d)}
                              onBlur={() => setEditingId(null)}
                            />
                          ) : can('devices', 'update') ? (
                            <button className="hover:underline" onClick={() => startRename(d)}>
                              {d.name}
                            </button>
                          ) : (
                            d.name
                          )}
                        </td>
                        <td className="py-1.5 pr-3">
                          {d.model} · {d.os_version}
                        </td>
                        <td className="py-1.5 pr-3">{fmtDate(d.created_at)}</td>
                        <td className="py-1.5 pr-3">{d.last_seen_at ? fmtDate(d.last_seen_at) : 'nunca'}</td>
                        <td className="py-1.5 pr-3">{situationLabel(d)}</td>
                        <td className="py-1.5 text-right">
                          {d.status === 'active' && can('devices', 'delete') && (
                            <button className="btn-ghost px-2 py-0.5 text-xs text-danger" aria-label={`Revogar ${d.name}`} onClick={() => setRevoking(d)}>
                              Revogar
                            </button>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        </>
      )}

      {!loading && events.length > 0 && (
        <section className="space-y-2">
          <h2 className="text-sm font-semibold">Atividade</h2>
          <ul className="space-y-1 text-sm text-fg-muted">
            {events.map((e) => (
              <li key={e.id} className="flex justify-between gap-3 border-t border-line py-1.5 first:border-0">
                <span>{e.text}</span>
                <span className="shrink-0 text-xs text-fg-dim">{fmtDate(e.created_at)}</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      <ConfirmDialog
        open={!!approving}
        title="Aprovar aparelho"
        message={`O código na tela do celular é ${approving?.verification_code ?? ''}?`}
        confirmLabel="Aprovar"
        onConfirm={confirmApprove}
        onCancel={() => setApproving(null)}
      />
      <ConfirmDialog
        open={!!revoking}
        title="Revogar aparelho"
        message="Ele perde o acesso na hora. Isso não pode ser desfeito."
        confirmLabel="Revogar"
        danger
        onConfirm={confirmRevoke}
        onCancel={() => setRevoking(null)}
      />
    </div>
  );
}
