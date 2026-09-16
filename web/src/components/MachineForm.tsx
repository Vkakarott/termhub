import { useState, type FormEvent } from 'react';
import { Modal } from './Modal';
import { useData } from '../lib/data';
import type { Machine } from '../lib/types';
import { ApiError } from '../lib/api';

interface Props {
  open: boolean;
  onClose: () => void;
  machine?: Machine | null;
}

export function MachineForm({ open, onClose, machine }: Props) {
  const { createMachine, updateMachine } = useData();
  const [name, setName] = useState(machine?.name ?? '');
  const [type, setType] = useState<'local' | 'ssh'>(machine?.type ?? 'ssh');
  const [host, setHost] = useState(machine?.host ?? '');
  const [sshUser, setSshUser] = useState(machine?.ssh_user ?? '');
  const [sshPort, setSshPort] = useState(String(machine?.ssh_port ?? 22));
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const input: Partial<Machine> = {
        name,
        type,
        host: type === 'ssh' ? host : null,
        ssh_user: type === 'ssh' ? sshUser || null : null,
        ssh_port: type === 'ssh' ? Number(sshPort) || 22 : 22,
      };
      if (machine) await updateMachine(machine.id, input);
      else await createMachine(input);
      onClose();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Erro ao salvar');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title={machine ? 'Editar máquina' : 'Nova máquina'} open={open} onClose={onClose}>
      <form onSubmit={submit} className="space-y-3">
        <div>
          <label className="label">Nome</label>
          <input className="input" value={name} onChange={(e) => setName(e.target.value)} required autoFocus placeholder="ex.: servidor-casa" />
        </div>
        <div>
          <label className="label">Tipo</label>
          <div className="flex gap-2">
            {(['ssh', 'local'] as const).map((t) => (
              <button
                key={t}
                type="button"
                onClick={() => setType(t)}
                className={`btn flex-1 border ${type === t ? 'border-accent bg-accent/15 text-fg' : 'border-line text-fg-muted hover:bg-bg-3'}`}
              >
                {t === 'ssh' ? 'SSH' : 'Local'}
              </button>
            ))}
          </div>
        </div>
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
            <p className="text-xs text-fg-dim">A autenticação usa a chave SSH já configurada no servidor do termhub (BatchMode).</p>
          </>
        )}
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
