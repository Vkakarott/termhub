import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { Modal } from './Modal';
import { DirectoryBrowser } from './DirectoryBrowser';
import { useData } from '../lib/data';
import { ApiError } from '../lib/api';

interface Props {
  open: boolean;
  onClose: () => void;
  machineId: string;
}

export function ProjectForm({ open, onClose, machineId }: Props) {
  const { createProject, machines } = useData();
  const navigate = useNavigate();
  const [name, setName] = useState('');
  const [cwd, setCwd] = useState('');
  const [description, setDescription] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [browsing, setBrowsing] = useState(false);
  const machine = machines.find((m) => m.id === machineId);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const project = await createProject({ machine_id: machineId, name, cwd, description: description || null });
      onClose();
      navigate(`/projects/${project.id}`);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Erro ao criar projeto');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title={`Novo projeto em ${machine?.name ?? 'máquina'}`} open={open} onClose={onClose} width={browsing ? 'max-w-2xl' : 'max-w-md'}>
      <form onSubmit={submit} className="space-y-3">
        <div>
          <label className="label">Nome</label>
          <input className="input" value={name} onChange={(e) => setName(e.target.value)} required autoFocus placeholder="ex.: meu-app" />
        </div>
        <div>
          <label className="label">Diretório (caminho absoluto na máquina)</label>
          <div className="flex gap-2">
            <input className="input font-mono" value={cwd} onChange={(e) => setCwd(e.target.value)} required placeholder="/home/pedro/projetos/meu-app" />
            <button type="button" className="btn-ghost shrink-0 border border-line" onClick={() => setBrowsing((b) => !b)} title="Listar discos e pastas da máquina">
              {browsing ? 'Ocultar' : 'Procurar…'}
            </button>
          </div>
          {browsing && (
            <div className="mt-2">
              <DirectoryBrowser
                machineId={machineId}
                initialPath={cwd}
                onSelect={(path) => {
                  setCwd(path);
                  if (!name) setName(path.split('/').filter(Boolean).pop() ?? '');
                  setBrowsing(false);
                }}
                onClose={() => setBrowsing(false)}
              />
            </div>
          )}
        </div>
        <div>
          <label className="label">Descrição (opcional)</label>
          <textarea className="input" rows={2} value={description} onChange={(e) => setDescription(e.target.value)} />
        </div>
        {error && <p className="text-sm text-danger">{error}</p>}
        <div className="flex justify-end gap-2 pt-2">
          <button type="button" className="btn-ghost" onClick={onClose}>
            Cancelar
          </button>
          <button type="submit" className="btn-primary" disabled={busy}>
            Criar
          </button>
        </div>
      </form>
    </Modal>
  );
}
