import { useEffect, useState, type FormEvent } from 'react';
import { Modal } from './Modal';
import { SimulatorSetupCard } from './SimulatorSetupCard';
import { useData } from '../lib/data';
import type { Machine, SshDiagnosis } from '../lib/types';
import { api, ApiError } from '../lib/api';

interface Props {
  open: boolean;
  onClose: () => void;
  machine?: Machine | null;
}

/**
 * One-liner that authorizes the termhub key on the target machine: creates ~/.ssh
 * with the right permissions, fixes the common mistake of authorized_keys being a
 * directory, appends the key only if it is not there yet.
 */
function authorizeCommand(publicKey: string): string {
  const key = publicKey.trim().replace(/'/g, `'\\''`);
  return `mkdir -p ~/.ssh && chmod 700 ~/.ssh && { [ -d ~/.ssh/authorized_keys ] && rmdir ~/.ssh/authorized_keys; true; } && touch ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys && { grep -qF '${key}' ~/.ssh/authorized_keys || echo '${key}' >> ~/.ssh/authorized_keys; }`;
}

type TargetOs = 'macos' | 'linux';

interface SetupStep {
  title: string;
  /** what the step does, one line */
  text: string;
  /** full command to paste on the target machine (null = GUI only) */
  command: string | null;
}

function setupSteps(os: TargetOs, publicKey: string | null): SetupStep[] {
  const authorize = publicKey ? authorizeCommand(publicKey) : null;
  if (os === 'macos') {
    return [
      {
        title: 'Ligar o servidor SSH',
        text: 'Ajustes do Sistema → Geral → Compartilhamento → Sessão Remota (ligado, com o seu usuário). Ou pelo terminal:',
        command: 'sudo systemsetup -setremotelogin on',
      },
      {
        title: 'Instalar o tmux',
        text: 'Cada tab do termhub é uma sessão tmux. Sem Homebrew, instale antes em https://brew.sh.',
        command: 'brew install tmux',
      },
      {
        title: 'Autorizar a chave do termhub',
        text: 'Cria ~/.ssh com as permissões certas e adiciona a chave uma única vez (pode repetir sem duplicar).',
        command: authorize,
      },
      {
        title: 'Descobrir o IP e testar',
        text: 'Informe o IP no campo Host, o usuário do Mac (whoami) e clique em "Testar conexão".',
        command: 'ipconfig getifaddr en0; whoami',
      },
    ];
  }
  return [
    {
      title: 'Ligar o servidor SSH',
      text: 'Instala e ativa o OpenSSH (Debian/Ubuntu; em outras distros use o gerenciador de pacotes).',
      command: 'sudo apt install -y openssh-server && sudo systemctl enable --now ssh',
    },
    { title: 'Instalar o tmux', text: 'Cada tab do termhub é uma sessão tmux.', command: 'sudo apt install -y tmux' },
    {
      title: 'Autorizar a chave do termhub',
      text: 'Cria ~/.ssh com as permissões certas e adiciona a chave uma única vez (pode repetir sem duplicar).',
      command: authorize,
    },
    {
      title: 'Descobrir o IP e testar',
      text: 'Informe o IP no campo Host, o usuário (whoami) e clique em "Testar conexão".',
      command: 'hostname -I; whoami',
    },
  ];
}

function CopyButton({ text }: { text: string }) {
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
  const { createMachine, updateMachine } = useData();
  const [name, setName] = useState(machine?.name ?? '');
  const [type, setType] = useState<'local' | 'ssh'>(machine?.type ?? 'ssh');
  const [host, setHost] = useState(machine?.host ?? '');
  const [sshUser, setSshUser] = useState(machine?.ssh_user ?? '');
  const [sshPort, setSshPort] = useState(String(machine?.ssh_port ?? 22));
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [sshKey, setSshKey] = useState<string | null>(null);
  const [targetOs, setTargetOs] = useState<TargetOs>(machine?.os === 'linux' ? 'linux' : 'macos');
  const [testing, setTesting] = useState(false);
  const [diag, setDiag] = useState<SshDiagnosis | null>(null);

  const runTest = async () => {
    setTesting(true);
    setDiag(null);
    try {
      setDiag(await api.machines.test({ host: host.trim(), ssh_user: sshUser.trim() || null, ssh_port: Number(sshPort) || 22 }));
    } catch (err) {
      setDiag({ ok: false, connected: false, tmux: false, os: null, problem: 'unknown', hint: err instanceof ApiError ? err.message : 'Erro ao testar', detail: null });
    } finally {
      setTesting(false);
    }
  };

  useEffect(() => {
    if (type !== 'ssh') return;
    api.system
      .sshKey()
      .then((r) => setSshKey(r.public_key))
      .catch(() => setSshKey(null));
  }, [type]);

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
            <div className="rounded-md border border-line bg-bg p-2 text-xs text-fg-dim">
              <div className="mb-2 flex items-center gap-2">
                <span className="font-medium text-fg-muted">Preparar a máquina</span>
                <span className="ml-auto flex gap-1 rounded border border-line p-0.5">
                  {(['macos', 'linux'] as TargetOs[]).map((o) => (
                    <button key={o} type="button" onClick={() => setTargetOs(o)} className={`rounded px-2 py-0.5 ${targetOs === o ? 'bg-accent/20 text-fg' : 'hover:bg-bg-3'}`}>
                      {o === 'macos' ? 'macOS' : 'Linux'}
                    </button>
                  ))}
                </span>
              </div>
              <ol className="space-y-2">
                {setupSteps(targetOs, sshKey).map((step, i) => (
                  <li key={step.title} className="flex gap-2">
                    <span className="flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-bg-4 text-[10px] font-semibold text-fg">{i + 1}</span>
                    <div className="min-w-0 flex-1">
                      <p className="text-fg">{step.title}</p>
                      <p className="mt-0.5">{step.text}</p>
                      {step.command ? (
                        <div className="mt-1">
                          <code className="block max-h-20 select-all overflow-auto whitespace-pre-wrap break-all rounded bg-bg-2 px-1.5 py-1 font-mono text-[10px] text-fg-muted">{step.command}</code>
                          <div className="mt-0.5 flex justify-end">
                            <CopyButton text={step.command} />
                          </div>
                        </div>
                      ) : (
                        i === 2 && <p className="mt-1 text-warn">Nenhuma chave pública encontrada no servidor do termhub (~/.ssh).</p>
                      )}
                    </div>
                  </li>
                ))}
              </ol>
              <div className="mt-2 flex items-center gap-2 border-t border-line pt-2">
                <button type="button" className="btn-ghost border border-line px-2 py-1 text-xs" disabled={testing || !host.trim()} onClick={() => void runTest()}>
                  {testing ? 'Testando…' : 'Testar conexão'}
                </button>
                {diag && (
                  <span className={diag.ok ? 'text-ok' : 'text-danger'}>
                    {diag.ok ? `Conectou · ${diag.os ?? 'SO ?'} · tmux ok` : diag.connected ? 'Conectou, mas falta o tmux' : 'Não conectou'}
                  </span>
                )}
              </div>
              {diag && !diag.ok && (
                <div className="mt-1.5 rounded border border-danger/40 bg-danger/10 p-2">
                  <p className="text-fg">{diag.hint}</p>
                  {diag.detail && <p className="mt-1 break-all font-mono text-[10px] text-fg-dim">{diag.detail}</p>}
                </div>
              )}
            </div>
          </>
        )}
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
