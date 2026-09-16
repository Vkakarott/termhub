import { useCallback, useEffect, useRef, useState, type DragEvent, type FormEvent } from 'react';
import { api, ApiError } from '../lib/api';
import { useData } from '../lib/data';
import { TASK_STATUS_LABEL, type Task, type TaskStatus } from '../lib/types';
import { Modal } from './Modal';

const COLUMNS: TaskStatus[] = ['todo', 'doing', 'done'];

interface Props {
  projectId: string;
}

interface DragState {
  taskId: string;
  overStatus: TaskStatus | null;
  overIndex: number | null;
}

export function TasksBoard({ projectId }: Props) {
  const { setOpenTasks } = useData();
  const [tasks, setTasks] = useState<Task[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<Task | null>(null);
  const [drag, setDrag] = useState<DragState | null>(null);

  const load = useCallback(async () => {
    try {
      const r = await api.tasks.list(projectId);
      setTasks(r.tasks);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Erro ao carregar tasks');
    }
  }, [projectId]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (tasks) setOpenTasks(projectId, tasks.filter((t) => t.status !== 'done').length);
  }, [tasks, projectId, setOpenTasks]);

  const byStatus = (s: TaskStatus) => (tasks ?? []).filter((t) => t.status === s).sort((a, b) => a.position - b.position);

  const fail = (e: unknown, fallback: string) => {
    setError(e instanceof ApiError ? e.message : fallback);
    void load();
  };

  const create = async (status: TaskStatus, title: string) => {
    try {
      const { task } = await api.tasks.create(projectId, { title, status });
      setTasks((t) => [...(t ?? []).map((x) => (x.status === status ? { ...x, position: x.position + 1 } : x)), task]);
    } catch (e) {
      fail(e, 'Erro ao criar task');
    }
  };

  const update = async (id: string, patch: { title?: string; description?: string | null }) => {
    setTasks((t) => (t ?? []).map((x) => (x.id === id ? { ...x, ...patch } : x)));
    try {
      await api.tasks.update(id, patch);
    } catch (e) {
      fail(e, 'Erro ao salvar task');
    }
  };

  const remove = async (id: string) => {
    setTasks((t) => (t ?? []).filter((x) => x.id !== id));
    setEditing(null);
    try {
      await api.tasks.remove(id);
    } catch (e) {
      fail(e, 'Erro ao excluir task');
    }
  };

  /** Move localmente (reindexando as colunas) e persiste. */
  const move = async (id: string, status: TaskStatus, index: number) => {
    const current = (tasks ?? []).find((t) => t.id === id);
    if (!current) return;
    const others = (tasks ?? []).filter((t) => t.id !== id);
    const target = others.filter((t) => t.status === status).sort((a, b) => a.position - b.position);
    const pos = Math.max(0, Math.min(index, target.length));
    target.splice(pos, 0, { ...current, status });
    const source = status === current.status ? [] : others.filter((t) => t.status === current.status).sort((a, b) => a.position - b.position);
    const rest = others.filter((t) => t.status !== status && t.status !== current.status);
    setTasks([
      ...rest,
      ...source.map((t, i) => ({ ...t, position: i })),
      ...target.map((t, i) => ({ ...t, position: i })),
    ]);
    try {
      await api.tasks.move(id, status, pos);
    } catch (e) {
      fail(e, 'Erro ao mover task');
    }
  };

  // --- drag and drop nativo ---
  const onDragStart = (e: DragEvent, task: Task) => {
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', task.id);
    setDrag({ taskId: task.id, overStatus: null, overIndex: null });
  };
  const onDragOverColumn = (e: DragEvent, status: TaskStatus, index: number) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    setDrag((d) => (d && (d.overStatus !== status || d.overIndex !== index) ? { ...d, overStatus: status, overIndex: index } : d));
  };
  const onDrop = (e: DragEvent, status: TaskStatus, index: number) => {
    e.preventDefault();
    const id = e.dataTransfer.getData('text/plain') || drag?.taskId;
    setDrag(null);
    if (id) void move(id, status, index);
  };

  if (tasks === null) return <div className="flex h-full items-center justify-center text-sm text-fg-dim">Carregando tasks…</div>;

  return (
    <div className="flex h-full flex-col">
      {error && (
        <div className="border-b border-danger/30 bg-danger/10 px-3 py-1 text-xs text-danger">
          {error}{' '}
          <button className="underline" onClick={() => setError(null)}>
            fechar
          </button>
        </div>
      )}
      <div className="grid min-h-0 flex-1 grid-cols-3 gap-3 overflow-x-auto p-3">
        {COLUMNS.map((status) => {
          const items = byStatus(status);
          const isOver = drag?.overStatus === status;
          return (
            <section
              key={status}
              className={`flex min-h-0 min-w-[220px] flex-col rounded-lg border bg-bg-2 ${isOver ? 'border-accent/60' : 'border-line'}`}
              onDragOver={(e) => onDragOverColumn(e, status, items.length)}
              onDrop={(e) => onDrop(e, status, drag?.overIndex ?? items.length)}
              onDragLeave={(e) => {
                if (!e.currentTarget.contains(e.relatedTarget as Node)) setDrag((d) => (d ? { ...d, overStatus: null, overIndex: null } : d));
              }}
            >
              <header className="flex items-center gap-2 px-3 py-2 text-xs font-semibold uppercase tracking-wide text-fg-muted">
                <span className={`h-2 w-2 rounded-full ${status === 'todo' ? 'bg-fg-dim' : status === 'doing' ? 'bg-accent' : 'bg-ok'}`} />
                {TASK_STATUS_LABEL[status]}
                <span className="ml-auto rounded-full bg-bg-4 px-1.5 text-[10px] tabular-nums">{items.length}</span>
              </header>
              <QuickAdd onAdd={(title) => void create(status, title)} />
              <ul className="min-h-0 flex-1 space-y-1.5 overflow-y-auto px-2 pb-2">
                {items.map((task, i) => (
                  <li
                    key={task.id}
                    onDragOver={(e) => {
                      e.stopPropagation();
                      const rect = e.currentTarget.getBoundingClientRect();
                      const before = e.clientY < rect.top + rect.height / 2;
                      onDragOverColumn(e, status, before ? i : i + 1);
                    }}
                    onDrop={(e) => {
                      e.stopPropagation();
                      onDrop(e, status, drag?.overIndex ?? i);
                    }}
                  >
                    {isOver && drag?.overIndex === i && drag.taskId !== task.id && <DropLine />}
                    <TaskCard
                      task={task}
                      dragging={drag?.taskId === task.id}
                      onDragStart={(e) => onDragStart(e, task)}
                      onDragEnd={() => setDrag(null)}
                      onOpen={() => setEditing(task)}
                      onRename={(title) => void update(task.id, { title })}
                      onMoveNext={
                        status !== 'done' ? () => void move(task.id, status === 'todo' ? 'doing' : 'done', 0) : undefined
                      }
                    />
                  </li>
                ))}
                {isOver && drag && drag.overIndex === items.length && <DropLine />}
                {items.length === 0 && !isOver && <li className="px-1 py-6 text-center text-xs text-fg-dim">vazio</li>}
              </ul>
            </section>
          );
        })}
      </div>

      {editing && (
        <TaskEditor
          task={tasks.find((t) => t.id === editing.id) ?? editing}
          onClose={() => setEditing(null)}
          onSave={(patch) => void update(editing.id, patch)}
          onStatus={(s) => void move(editing.id, s, 0)}
          onDelete={() => void remove(editing.id)}
        />
      )}
    </div>
  );
}

function DropLine() {
  return <div className="my-1 h-0.5 rounded bg-accent" />;
}

function QuickAdd({ onAdd }: { onAdd: (title: string) => void }) {
  const [value, setValue] = useState('');
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const v = value.trim();
    if (!v) return;
    onAdd(v);
    setValue('');
  };
  return (
    <form onSubmit={submit} className="px-2 pb-2">
      <input
        className="input py-1.5 text-xs"
        placeholder="+ nova task (Enter)"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') setValue('');
        }}
      />
    </form>
  );
}

interface CardProps {
  task: Task;
  dragging: boolean;
  onDragStart: (e: DragEvent) => void;
  onDragEnd: () => void;
  onOpen: () => void;
  onRename: (title: string) => void;
  onMoveNext?: () => void;
}

function TaskCard({ task, dragging, onDragStart, onDragEnd, onOpen, onRename, onMoveNext }: CardProps) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(task.title);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (editing) inputRef.current?.select();
  }, [editing]);

  const commit = () => {
    setEditing(false);
    const v = draft.trim();
    if (v && v !== task.title) onRename(v);
    else setDraft(task.title);
  };

  return (
    <div
      draggable={!editing}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      onDoubleClick={() => {
        setDraft(task.title);
        setEditing(true);
      }}
      onClick={() => !editing && onOpen()}
      className={`group cursor-grab rounded-md border border-line bg-bg-3 px-2.5 py-2 text-sm hover:border-fg-dim active:cursor-grabbing ${
        dragging ? 'opacity-40' : ''
      } ${task.status === 'done' ? 'text-fg-muted line-through decoration-fg-dim' : ''}`}
    >
      {editing ? (
        <input
          ref={inputRef}
          className="w-full bg-transparent outline-none"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === 'Enter') commit();
            if (e.key === 'Escape') {
              setDraft(task.title);
              setEditing(false);
            }
          }}
          onClick={(e) => e.stopPropagation()}
        />
      ) : (
        <div className="flex items-start gap-2">
          <span className="flex-1 break-words">{task.title}</span>
          {onMoveNext && (
            <button
              className="invisible shrink-0 rounded px-1 text-xs text-fg-dim hover:bg-bg-4 hover:text-fg group-hover:visible"
              title={task.status === 'todo' ? 'Mover para Fazendo' : 'Concluir'}
              onClick={(e) => {
                e.stopPropagation();
                onMoveNext();
              }}
            >
              {task.status === 'todo' ? '→' : '✓'}
            </button>
          )}
        </div>
      )}
      {task.description && !editing && <p className="mt-1 line-clamp-2 text-xs text-fg-dim">{task.description}</p>}
    </div>
  );
}

interface EditorProps {
  task: Task;
  onClose: () => void;
  onSave: (patch: { title?: string; description?: string | null }) => void;
  onStatus: (s: TaskStatus) => void;
  onDelete: () => void;
}

function TaskEditor({ task, onClose, onSave, onStatus, onDelete }: EditorProps) {
  const [title, setTitle] = useState(task.title);
  const [description, setDescription] = useState(task.description ?? '');
  const [confirmDelete, setConfirmDelete] = useState(false);

  const save = () => {
    const patch: { title?: string; description?: string | null } = {};
    if (title.trim() && title.trim() !== task.title) patch.title = title.trim();
    if ((description.trim() || null) !== (task.description ?? null)) patch.description = description.trim() || null;
    if (Object.keys(patch).length) onSave(patch);
    onClose();
  };

  return (
    <Modal title="Task" open onClose={onClose} width="max-w-lg">
      <div className="space-y-3">
        <div>
          <label className="label">Título</label>
          <input className="input" value={title} onChange={(e) => setTitle(e.target.value)} autoFocus />
        </div>
        <div>
          <label className="label">Descrição</label>
          <textarea className="input min-h-[120px] font-mono text-xs" value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Detalhes, links, contexto…" />
        </div>
        <div>
          <label className="label">Status</label>
          <div className="flex gap-2">
            {COLUMNS.map((s) => (
              <button
                key={s}
                type="button"
                onClick={() => task.status !== s && onStatus(s)}
                className={`btn flex-1 border ${task.status === s ? 'border-accent bg-accent/15 text-fg' : 'border-line text-fg-muted hover:bg-bg-3'}`}
              >
                {TASK_STATUS_LABEL[s]}
              </button>
            ))}
          </div>
        </div>
        <div className="flex items-center justify-between pt-2 text-xs text-fg-dim">
          <span>criada em {new Date(task.created_at).toLocaleDateString('pt-BR')}</span>
          <div className="flex gap-2">
            {confirmDelete ? (
              <>
                <span className="self-center">Excluir?</span>
                <button className="btn-danger" onClick={onDelete}>
                  Sim, excluir
                </button>
                <button className="btn-ghost" onClick={() => setConfirmDelete(false)}>
                  Não
                </button>
              </>
            ) : (
              <button className="btn-ghost text-danger" onClick={() => setConfirmDelete(true)}>
                Excluir
              </button>
            )}
            <button className="btn-primary" onClick={save}>
              Salvar
            </button>
          </div>
        </div>
      </div>
    </Modal>
  );
}
