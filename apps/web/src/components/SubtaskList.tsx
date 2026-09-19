import { useState, type DragEvent, type FormEvent } from 'react';
import { api, ApiError } from '../lib/api';
import type { Task } from '../lib/types';

interface Props {
  parent: Task;
  /** The full, reindexed list after every change (optimistic; rolled back on failure). */
  onChange: (subtasks: Task[]) => void;
  onError: (message: string) => void;
}

const reindex = (list: Task[]) => list.map((s, i) => ({ ...s, position: i }));

/** Checklist of a task's subtasks: toggle, rename, add, delete and drag to reorder. Owns its API calls. */
export function SubtaskList({ parent, onChange, onError }: Props) {
  const subtasks = [...(parent.subtasks ?? [])].sort((a, b) => a.position - b.position);
  const [draft, setDraft] = useState('');
  const [renaming, setRenaming] = useState<{ id: string; title: string } | null>(null);
  const [dragId, setDragId] = useState<string | null>(null);
  const done = subtasks.filter((s) => s.status === 'done').length;

  /** Applies `next` now; restores the current list and reports if `save` rejects. */
  const commit = async (next: Task[], save: () => Promise<unknown>, fallback: string) => {
    onChange(next);
    try {
      await save();
    } catch (e) {
      onChange(subtasks);
      onError(e instanceof ApiError ? e.message : fallback);
    }
  };

  const toggle = (s: Task) => {
    const status = s.status === 'done' ? 'todo' : 'done';
    void commit(
      subtasks.map((x) => (x.id === s.id ? { ...x, status } : x)),
      () => api.tasks.update(s.id, { status }),
      'Erro ao salvar subtarefa',
    );
  };

  const rename = () => {
    if (!renaming) return;
    const { id, title } = renaming;
    setRenaming(null);
    const v = title.trim();
    if (!v || v === subtasks.find((s) => s.id === id)?.title) return;
    void commit(
      subtasks.map((x) => (x.id === id ? { ...x, title: v } : x)),
      () => api.tasks.update(id, { title: v }),
      'Erro ao salvar subtarefa',
    );
  };

  const add = async (e: FormEvent) => {
    e.preventDefault();
    const title = draft.trim();
    if (!title) return;
    setDraft('');
    try {
      const r = await api.tasks.addSubtasks(parent.id, [{ title }]);
      onChange([...subtasks, ...r.subtasks]);
    } catch (err) {
      setDraft(title);
      onError(err instanceof ApiError ? err.message : 'Erro ao criar subtarefa');
    }
  };

  const remove = (s: Task) =>
    void commit(
      reindex(subtasks.filter((x) => x.id !== s.id)),
      () => api.tasks.remove(s.id),
      'Erro ao excluir subtarefa',
    );

  const dropOn = (e: DragEvent, index: number) => {
    e.preventDefault();
    const id = dragId;
    setDragId(null);
    if (!id) return;
    const moving = subtasks.find((s) => s.id === id);
    if (!moving || subtasks.indexOf(moving) === index) return;
    const rest = subtasks.filter((s) => s.id !== id);
    rest.splice(index, 0, moving);
    void commit(reindex(rest), () => api.tasks.reorder(id, index), 'Erro ao reordenar subtarefas');
  };

  return (
    <div>
      <label className="label flex items-center gap-2">
        Subtarefas
        {subtasks.length > 0 && (
          <span className="font-normal normal-case text-fg-dim">
            {done} de {subtasks.length} concluídas
          </span>
        )}
      </label>
      <ul className="space-y-1">
        {subtasks.map((s, i) => (
          <li
            key={s.id}
            draggable={renaming?.id !== s.id}
            onDragStart={(e) => {
              e.dataTransfer.effectAllowed = 'move';
              setDragId(s.id);
            }}
            onDragEnd={() => setDragId(null)}
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => dropOn(e, i)}
            className={`group flex cursor-grab items-center gap-2 rounded-md border border-line bg-bg-3 px-2 py-1 text-sm ${dragId === s.id ? 'opacity-40' : ''}`}
          >
            <input type="checkbox" aria-label={s.title} checked={s.status === 'done'} onChange={() => toggle(s)} />
            {renaming?.id === s.id ? (
              <input
                className="flex-1 bg-transparent outline-none"
                autoFocus
                value={renaming.title}
                onChange={(e) => setRenaming({ id: s.id, title: e.target.value })}
                onBlur={rename}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') rename();
                  if (e.key === 'Escape') setRenaming(null);
                }}
              />
            ) : (
              <span
                className={`flex-1 cursor-text break-words ${s.status === 'done' ? 'text-fg-muted line-through decoration-fg-dim' : ''}`}
                onClick={() => setRenaming({ id: s.id, title: s.title })}
              >
                {s.title}
              </span>
            )}
            {s.status === 'doing' && <span className="shrink-0 rounded bg-accent/15 px-1 text-[10px] text-accent">em andamento</span>}
            <button
              type="button"
              aria-label={`Excluir subtarefa ${s.title}`}
              title="Excluir subtarefa"
              className="invisible shrink-0 rounded px-1 text-xs text-fg-dim hover:bg-bg-4 hover:text-danger group-hover:visible"
              onClick={() => remove(s)}
            >
              ✕
            </button>
          </li>
        ))}
      </ul>
      <form onSubmit={add} className="mt-1">
        <input className="input py-1.5 text-xs" placeholder="Adicionar subtarefa (Enter)" value={draft} onChange={(e) => setDraft(e.target.value)} />
      </form>
    </div>
  );
}
