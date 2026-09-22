import { useEffect, useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { Modal } from './Modal';
import { DirectoryBrowser } from './DirectoryBrowser';
import { useData } from '../lib/data';
import { api, ApiError } from '../lib/api';
import { isValidProjectKey, suggestProjectKey } from '../lib/project-key';

interface Props {
  open: boolean;
  onClose: () => void;
  /** preselects the machine block (the "+" on a machine row) */
  machineId?: string;
}

type KeyState = { kind: 'idle' } | { kind: 'checking' } | { kind: 'ok' } | { kind: 'taken' } | { kind: 'invalid' };

export function ProjectForm({ open, onClose, machineId }: Props) {
  const { createProject, machines } = useData();
  const navigate = useNavigate();
  const [name, setName] = useState('');
  const [key, setKey] = useState('');
  const [keyEdited, setKeyEdited] = useState(false);
  const [keyState, setKeyState] = useState<KeyState>({ kind: 'idle' });
  const [description, setDescription] = useState('');
  const [machine, setMachine] = useState<string>(machineId ?? '');
  const [cwd, setCwd] = useState('');
  const [createDir, setCreateDir] = useState(true);
  const [browsing, setBrowsing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // suggestion follows the name until the person edits the key by hand
  const onName = (v: string) => {
    setName(v);
    if (!keyEdited) setKey(v.trim() ? suggestProjectKey(v) : '');
  };

  // availability: debounced, invalid keys never hit the server
  useEffect(() => {
    if (!key) return setKeyState({ kind: 'idle' });
    if (!isValidProjectKey(key)) return setKeyState({ kind: 'invalid' });
    setKeyState({ kind: 'checking' });
    let cancelled = false;
    const t = setTimeout(() => {
      api.projects
        .keyAvailable(key)
        .then((r) => !cancelled && setKeyState(r.available ? { kind: 'ok' } : { kind: r.reason === 'invalid' ? 'invalid' : 'taken' }))
        .catch(() => !cancelled && setKeyState({ kind: 'idle' }));
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [key]);

  const canSubmit = !busy && !!name.trim() && keyState.kind === 'ok' && (!machine || !!cwd.trim());

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!canSubmit) return;
    setBusy(true);
    setError(null);
    try {
      const project = await createProject({
        name: name.trim(),
        key,
        description: description || null,
        ...(machine ? { machine_id: machine, cwd, create_dir: createDir } : {}),
      });
      onClose();
      navigate(`/projects/${project.id}`);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Erro ao criar projeto');
    } finally {
      setBusy(false);
    }
  };

  const keyHint: Record<KeyState['kind'], { text: string; cls: string }> = {
    idle: { text: '', cls: '' },
    checking: { text: 'verificando…', cls: 'text-fg-dim' },
    ok: { text: 'disponível', cls: 'text-ok' },
    taken: { text: 'já em uso', cls: 'text-danger' },
    invalid: { text: 'formato inválido', cls: 'text-danger' },
  };

  return (
    <Modal title="Novo projeto" open={open} onClose={onClose} width={browsing ? 'max-w-2xl' : 'max-w-md'}>
      <form onSubmit={submit} className="space-y-3">
        <div>
          <label className="label" htmlFor="project-name">Nome</label>
          <input id="project-name" className="input" value={name} onChange={(e) => onName(e.target.value)} required autoFocus placeholder="ex.: meu-app" />
        </div>
        <div>
          <label className="label" htmlFor="project-key">Chave</label>
          <div className="flex items-center gap-2">
            <input
              id="project-key"
              className="input w-40 font-mono uppercase"
              value={key}
              onChange={(e) => {
                setKeyEdited(true);
                setKey(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 10));
              }}
              required
              placeholder="APP"
            />
            <span className={`text-xs ${keyHint[keyState.kind].cls}`}>{keyHint[keyState.kind].text}</span>
          </div>
          <p className="mt-1 text-xs text-fg-dim">2 a 10 letras ou dígitos, começando com letra. Aparece nas URLs e nos números dos cards (ex.: {key || 'APP'}-12). Não muda depois.</p>
        </div>
        <div>
          <label className="label" htmlFor="project-machine">Máquina (opcional)</label>
          <select id="project-machine" className="input" value={machine} onChange={(e) => setMachine(e.target.value)}>
            <option value="">Sem máquina por enquanto</option>
            {machines.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name}
              </option>
            ))}
          </select>
          {!machine && <p className="mt-1 text-xs text-fg-dim">Sem máquina o projeto nasce só com quadro e notas; vincule uma depois em Setup → Máquinas.</p>}
        </div>
        {machine && (
          <div>
            <label className="label" htmlFor="project-cwd">Diretório (caminho absoluto na máquina)</label>
            <div className="flex gap-2">
              <input id="project-cwd" className="input font-mono" value={cwd} onChange={(e) => setCwd(e.target.value)} required placeholder="/home/pedro/projetos/meu-app" />
              <button type="button" className="btn-ghost shrink-0 border border-line" onClick={() => setBrowsing((b) => !b)} title="Listar discos e pastas da máquina">
                {browsing ? 'Ocultar' : 'Procurar…'}
              </button>
            </div>
            <label className="mt-1.5 flex items-center gap-1.5 text-xs text-fg-muted">
              <input type="checkbox" checked={createDir} onChange={(e) => setCreateDir(e.target.checked)} /> criar a pasta na máquina se não existir
            </label>
            {browsing && (
              <div className="mt-2">
                <DirectoryBrowser
                  machineId={machine}
                  initialPath={cwd}
                  onSelect={(path) => {
                    setCwd(path);
                    if (!name) onName(path.split('/').filter(Boolean).pop() ?? '');
                    setBrowsing(false);
                  }}
                  onClose={() => setBrowsing(false)}
                />
              </div>
            )}
          </div>
        )}
        <div>
          <label className="label" htmlFor="project-description">Descrição (opcional)</label>
          <textarea id="project-description" className="input" rows={2} value={description} onChange={(e) => setDescription(e.target.value)} />
        </div>
        {error && <p className="text-sm text-danger">{error}</p>}
        <div className="flex justify-end gap-2 pt-2">
          <button type="button" className="btn-ghost" onClick={onClose}>
            Cancelar
          </button>
          <button type="submit" className="btn-primary" disabled={!canSubmit}>
            Criar
          </button>
        </div>
      </form>
    </Modal>
  );
}
