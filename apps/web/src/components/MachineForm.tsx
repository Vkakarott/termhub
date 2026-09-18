import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { useAuth } from '../lib/auth';
import { Modal } from './Modal';
import { SimulatorSetupCard } from './SimulatorSetupCard';
import { AgentEnrollment } from './AgentEnrollment';
import { MonitorHooksCard } from './MonitorHooksCard';
import { useData } from '../lib/data';
import type { Machine, User } from '../lib/types';
import { api, ApiError } from '../lib/api';

interface Props {
  open: boolean;
  onClose: () => void;
  machine?: Machine | null;
}

/** Legacy transports (kept for machines that already exist; new machines are agent-only). */
const TYPE_LABEL = { agent: 'Agente', ssh: 'SSH (legado)', local: 'Servidor do termhub (legado)' } as const;

export function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className="btn-ghost shrink-0 px-1.5 py-0.5 text-[10px]"
      onClick={() => {
        void navigator.clipboard?.writeText(text);
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1500);
      }}
    >
      {copied ? 'copiado' : 'copiar'}
    </button>
  );
}

export function MachineForm({ open, onClose, machine }: Props) {
  const { updateMachine, refresh, claimLocal } = useData();
  const { user: me } = useAuth();
  const isAdmin = !!me?.role_info?.is_admin;
  // Owner transfer: admins editing an existing machine can hand it to another user.
  const [owners, setOwners] = useState<User[] | null>(null);
  const [ownerId, setOwnerId] = useState<string>(machine?.owner_id ?? '');
  const [name, setName] = useState(machine?.name ?? '');
  const type = machine?.type ?? 'agent';
  const [host, setHost] = useState(machine?.host ?? '');
  const [sshUser, setSshUser] = useState(machine?.ssh_user ?? '');
  const [sshPort, setSshPort] = useState(String(machine?.ssh_port ?? 22));
  const [isLocal, setIsLocal] = useState(machine?.is_local ?? false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [rotating, setRotating] = useState(false);
  // Set once a fresh agent token is minted (new agent machine, or a token rotation): swaps the
  // form body for the enrollment steps. The token is shown only this once.
  const [enrollment, setEnrollment] = useState<{ machine: Machine; token: string } | null>(null);

  useEffect(() => {
    if (!isAdmin || !machine) return;
    api.users
      .list()
      .then((r) => setOwners(r.users))
      .catch(() => setOwners(null));
  }, [isAdmin, machine]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      if (!machine) {
        // Bypass the data context here: we need the one-time `agent_token` from the raw
        // response, not just the created Machine it returns.
        const res = await api.machines.create({ name, type: 'agent', is_local: isLocal });
        if (res.machine.is_local) claimLocal(res.machine.id);
        await refresh();
        if (res.agent_token) setEnrollment({ machine: res.machine, token: res.agent_token });
        else onClose();
        return;
      }
      const input: Partial<Machine> = {
        name,
        type,
        host: type === 'ssh' ? host : null,
        ssh_user: type === 'ssh' ? sshUser || null : null,
        ssh_port: type === 'ssh' ? Number(sshPort) || 22 : 22,
        is_local: type === 'agent' && isLocal,
      };
      if (isAdmin && owners && (ownerId || null) !== machine.owner_id) input.owner_id = ownerId || null;
      await updateMachine(machine.id, input);
      onClose();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Erro ao salvar');
    } finally {
      setBusy(false);
    }
  };

  const rotateToken = async () => {
    if (!machine) return;
    if (!window.confirm('Gerar um novo token? O agente atual será desconectado.')) return;
    setRotating(true);
    setError(null);
    try {
      const { agent_token } = await api.machines.rotateAgentToken(machine.id);
      setEnrollment({ machine, token: agent_token });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Erro ao gerar token');
    } finally {
      setRotating(false);
    }
  };

  // Stable across re-renders (MachineForm re-renders on every DataContext change, e.g. the
  // 30 s status loop): a new function identity on each render would retrigger AgentEnrollment's
  // polling effect and restart its interval.
  const onConnectedEnrolled = useCallback(() => void refresh(), [refresh]);

  if (enrollment) {
    return (
      <Modal title={enrollment.machine.name} open={open} onClose={onClose}>
        <div className="space-y-3">
          <AgentEnrollment machine={enrollment.machine} token={enrollment.token} onConnected={onConnectedEnrolled} />
          <div className="flex justify-end pt-2">
            <button type="button" className="btn-primary" onClick={onClose}>
              Fechar
            </button>
          </div>
        </div>
      </Modal>
    );
  }

  return (
    <Modal title={machine ? 'Editar máquina' : 'Nova máquina'} open={open} onClose={onClose}>
      <form onSubmit={submit} className="space-y-3">
        <div>
          <label className="label">Nome</label>
          <input className="input" value={name} onChange={(e) => setName(e.target.value)} required autoFocus placeholder="ex.: meu notebook" />
        </div>
        {machine && type !== 'agent' && (
          <p className="rounded-md border border-line bg-bg p-2 text-xs text-fg-dim">
            Tipo: <span className="text-fg-muted">{TYPE_LABEL[type]}</span>. Máquinas novas só podem ser adicionadas com o agente
            {type === 'local' && ' — esta é a própria máquina onde o termhub roda, não o seu computador'}.
          </p>
        )}
        {type === 'agent' && (
          <>
            {!machine && (
              <p className="rounded-md border border-line bg-bg p-2 text-xs text-fg-dim">
                Serve para o seu próprio computador ou para um servidor: um cliente leve (o agente) roda na máquina e conecta ao termhub. Nada de
                SSH, nada de portas abertas.
              </p>
            )}
            <label className="flex items-start gap-2 text-sm text-fg-muted">
              <input type="checkbox" className="mt-0.5 accent-accent" checked={isLocal} onChange={(e) => setIsLocal(e.target.checked)} />
              <span>
                É o computador que estou usando agora
                <span className="block text-[11px] text-fg-dim">Aparece só neste navegador; em outros computadores ela fica oculta.</span>
              </span>
            </label>
          </>
        )}
        {machine && type === 'agent' && (
          <div className="flex items-center gap-2">
            <button type="button" className="btn-ghost border border-line px-2 py-1 text-xs" disabled={rotating} onClick={() => void rotateToken()}>
              {rotating ? 'Gerando…' : 'Rotacionar token'}
            </button>
          </div>
        )}
        {type === 'ssh' && (
          <>
            <div>
              <label className="label">Host</label>
              <input className="input" value={host} onChange={(e) => setHost(e.target.value)} required placeholder="192.168.1.10 ou nome.local" />
            </div>
            <div className="grid grid-cols-3 gap-2">
              <div className="col-span-2">
                <label className="label">Usuário SSH</label>
                <input className="input" value={sshUser} onChange={(e) => setSshUser(e.target.value)} placeholder="pedro" />
              </div>
              <div>
                <label className="label">Porta</label>
                <input className="input" value={sshPort} onChange={(e) => setSshPort(e.target.value)} inputMode="numeric" />
              </div>
            </div>
          </>
        )}
        {machine && isAdmin && owners && (
          <div>
            <label className="label">Dono</label>
            <select className="input" value={ownerId} onChange={(e) => setOwnerId(e.target.value)}>
              <option value="">— sem dono (só visível em "todas as máquinas") —</option>
              {owners.map((u) => (
                <option key={u.id} value={u.id}>
                  {u.name} — {u.email}
                </option>
              ))}
            </select>
            <p className="mt-1 text-[11px] text-fg-dim">Projetos, tabs, tarefas, notas e contas de IA desta máquina passam a ser vistos pelo novo dono.</p>
          </div>
        )}
        {machine && <MonitorHooksCard machine={machine} />}
        {machine && <SimulatorSetupCard machine={machine} />}
        {error && <p className="text-sm text-danger">{error}</p>}
        <div className="flex justify-end gap-2 pt-2">
          <button type="button" className="btn-ghost" onClick={onClose}>
            Cancelar
          </button>
          <button type="submit" className="btn-primary" disabled={busy}>
            {machine ? 'Salvar' : 'Criar'}
          </button>
        </div>
      </form>
    </Modal>
  );
}
