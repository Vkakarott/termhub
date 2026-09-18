import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { NavLink, useParams } from 'react-router-dom';
import { api, ApiError } from '../lib/api';
import { useAuth } from '../lib/auth';
import type { PermissionAction, ResourcePermissions, Role, User } from '../lib/types';
import { ConfirmDialog, Modal } from '../components/Modal';

/**
 * Settings: users, roles and the permission matrix (resource × create/read/update/delete).
 * Same model as the engenhariainversa CMS: admin roles bypass everything, system roles cannot be deleted.
 */

type Section = 'users' | 'roles' | 'permissions';
const SECTIONS: { key: Section; label: string; resource: string }[] = [
  { key: 'users', label: 'Usuários', resource: 'users' },
  { key: 'roles', label: 'Roles', resource: 'roles' },
  { key: 'permissions', label: 'Permissões', resource: 'roles' },
];
const ACTION_LABELS: Record<PermissionAction, string> = { create: 'Criar', read: 'Ver', update: 'Editar', delete: 'Excluir' };
const ACTIONS: PermissionAction[] = ['create', 'read', 'update', 'delete'];

export function SettingsPage() {
  const { section } = useParams<{ section?: string }>();
  const { can } = useAuth();
  const visible = SECTIONS.filter((s) => can(s.resource));
  const current = (visible.find((s) => s.key === section) ?? visible[0])?.key;

  return (
    <div className="flex h-full flex-col">
      <nav className="flex h-11 shrink-0 items-center gap-1 border-b border-line bg-bg-2 px-4">
        <span className="mr-3 text-sm font-semibold">Configurações</span>
        {visible.map((s) => (
          <NavLink key={s.key} to={`/settings/${s.key}`} className={({ isActive }) => `rounded px-3 py-1 text-sm ${isActive || (current === s.key && !section) ? 'bg-accent/15 text-fg' : 'text-fg-muted hover:bg-bg-3 hover:text-fg'}`}>
            {s.label}
          </NavLink>
        ))}
      </nav>
      <div className="min-h-0 flex-1 overflow-y-auto p-6">
        {current === 'users' && <UsersSection />}
        {current === 'roles' && <RolesSection />}
        {current === 'permissions' && <PermissionsSection />}
        {!current && <p className="text-sm text-fg-dim">Sem permissão para ver as configurações.</p>}
      </div>
    </div>
  );
}

// ── Users ────────────────────────────────────────────────────────────────────

function UsersSection() {
  const { user: me, can } = useAuth();
  const [users, setUsers] = useState<User[] | null>(null);
  const [roles, setRoles] = useState<Role[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<User | null>(null);

  const load = useCallback(async () => {
    try {
      const [u, r] = await Promise.all([api.users.list(), api.roles.list()]);
      setUsers(u.users);
      setRoles(r.roles);
      setError(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Erro ao carregar');
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  const setRole = async (u: User, roleId: string) => {
    try {
      const r = await api.users.setRole(u.id, roleId);
      setUsers((l) => (l ?? []).map((x) => (x.id === u.id ? r.user : x)));
      setError(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Erro ao alterar a role');
    }
  };

  return (
    <div className="max-w-4xl">
      <div className="mb-4">
        <h1 className="text-lg font-semibold">Usuários</h1>
        <p className="text-sm text-fg-muted">
          {users ? `${users.length} usuário(s).` : 'Carregando…'} Novos usuários entram pela CLI (<code className="font-mono text-xs">npm run create-user</code>) ou pelo primeiro login com Google, quando ativado.
        </p>
      </div>
      {error && <p className="mb-3 text-sm text-danger">{error}</p>}
      {users && (
        <div className="overflow-x-auto rounded-lg border border-line bg-bg-2">
          <table className="w-full text-sm">
            <thead className="text-left text-[11px] uppercase tracking-wide text-fg-dim">
              <tr className="border-b border-line">
                <th className="px-3 py-2">Nome</th>
                <th className="px-3 py-2">E-mail</th>
                <th className="px-3 py-2">Login</th>
                <th className="px-3 py-2">Role</th>
                <th className="px-3 py-2" />
              </tr>
            </thead>
            <tbody>
              {users.map((u) => (
                <tr key={u.id} className="border-b border-line last:border-0">
                  <td className="px-3 py-2">
                    <span className="flex items-center gap-2">
                      {u.avatar_url ? <img src={u.avatar_url} alt="" className="h-5 w-5 rounded-full" referrerPolicy="no-referrer" /> : <span className="flex h-5 w-5 items-center justify-center rounded-full bg-bg-4 text-[10px]">{u.name[0]?.toUpperCase()}</span>}
                      {u.name}
                      {u.id === me?.id && <span className="text-[10px] text-fg-dim">(você)</span>}
                    </span>
                  </td>
                  <td className="px-3 py-2 text-fg-muted">{u.email}</td>
                  <td className="px-3 py-2 text-xs text-fg-dim">
                    {[u.has_google && 'Google', u.has_password && 'senha', 'e-mail'].filter(Boolean).join(' · ')}
                  </td>
                  <td className="px-3 py-2">
                    {can('users', 'update') ? (
                      <select className="input w-auto py-1 text-xs" value={u.role_info?.id ?? ''} onChange={(e) => void setRole(u, e.target.value)}>
                        {!u.role_info && <option value="">— sem role —</option>}
                        {roles.map((r) => (
                          <option key={r.id} value={r.id}>
                            {r.label}
                          </option>
                        ))}
                      </select>
                    ) : (
                      <span className="text-xs">{u.role_info?.label ?? '—'}</span>
                    )}
                  </td>
                  <td className="px-3 py-2 text-right">
                    {can('users', 'delete') && u.id !== me?.id && (
                      <button className="rounded px-1 text-xs text-fg-dim hover:bg-bg-4 hover:text-danger" title="Excluir" onClick={() => setDeleting(u)}>
                        ✕
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <ConfirmDialog
        open={!!deleting}
        title="Excluir usuário"
        message={
          <>
            Excluir <strong>{deleting?.email}</strong>? As sessões dele são encerradas.
          </>
        }
        confirmLabel="Excluir"
        danger
        onCancel={() => setDeleting(null)}
        onConfirm={async () => {
          if (!deleting) return;
          try {
            await api.users.remove(deleting.id);
            setUsers((l) => (l ?? []).filter((x) => x.id !== deleting.id));
          } catch (err) {
            setError(err instanceof ApiError ? err.message : 'Erro ao excluir');
          }
          setDeleting(null);
        }}
      />
    </div>
  );
}

// ── Roles ────────────────────────────────────────────────────────────────────

function RoleForm({ role, onClose, onSaved }: { role: Role | null; onClose: () => void; onSaved: (r: Role) => void }) {
  const [name, setName] = useState(role?.name ?? '');
  const [label, setLabel] = useState(role?.label ?? '');
  const [description, setDescription] = useState(role?.description ?? '');
  const [isAdmin, setIsAdmin] = useState(role?.is_admin ?? false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const r = role
        ? await api.roles.update(role.id, { label, description: description || null, is_admin: isAdmin })
        : await api.roles.create({ name: name.toUpperCase(), label, description: description || null, is_admin: isAdmin });
      onSaved(r.role);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Erro ao salvar');
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal title={role ? `Editar role ${role.name}` : 'Nova role'} open onClose={onClose}>
      <form onSubmit={submit} className="space-y-3">
        {!role && (
          <div>
            <label className="label">Nome (identificador)</label>
            <input className="input font-mono uppercase" value={name} onChange={(e) => setName(e.target.value.toUpperCase())} required placeholder="EX.: SUPPORT" pattern="[A-Z][A-Z0-9_]*" />
          </div>
        )}
        <div>
          <label className="label">Rótulo</label>
          <input className="input" value={label} onChange={(e) => setLabel(e.target.value)} required placeholder="ex.: Suporte" autoFocus />
        </div>
        <div>
          <label className="label">Descrição</label>
          <textarea className="input" rows={2} value={description} onChange={(e) => setDescription(e.target.value)} />
        </div>
        {!role?.is_system && (
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={isAdmin} onChange={(e) => setIsAdmin(e.target.checked)} /> Administrador (acesso total, ignora a matriz)
          </label>
        )}
        {error && <p className="text-sm text-danger">{error}</p>}
        <div className="flex justify-end gap-2 pt-2">
          <button type="button" className="btn-ghost" onClick={onClose}>
            Cancelar
          </button>
          <button type="submit" className="btn-primary" disabled={busy}>
            {role ? 'Salvar' : 'Criar'}
          </button>
        </div>
      </form>
    </Modal>
  );
}

function RolesSection() {
  const { can } = useAuth();
  const [roles, setRoles] = useState<Role[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState<{ open: boolean; role: Role | null }>({ open: false, role: null });
  const [deleting, setDeleting] = useState<Role | null>(null);

  const load = useCallback(() => api.roles.list().then((r) => setRoles(r.roles)).catch((err) => setError(err instanceof ApiError ? err.message : 'Erro ao carregar')), []);
  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div className="max-w-4xl">
      <div className="mb-4 flex items-end gap-4">
        <div>
          <h1 className="text-lg font-semibold">Roles</h1>
          <p className="text-sm text-fg-muted">Uma role é um conjunto de permissões. Roles de administrador têm acesso total; roles do sistema não podem ser excluídas.</p>
        </div>
        {can('roles', 'create') && (
          <button className="btn-primary ml-auto text-xs" onClick={() => setForm({ open: true, role: null })}>
            + role
          </button>
        )}
      </div>
      {error && <p className="mb-3 text-sm text-danger">{error}</p>}
      <ul className="grid gap-3 md:grid-cols-2">
        {roles?.map((r) => (
          <li key={r.id} className="rounded-lg border border-line bg-bg-2 p-4">
            <div className="flex items-center gap-2">
              <span className="font-mono text-xs text-fg-dim">{r.name}</span>
              {r.is_admin && <span className="rounded bg-accent/15 px-1.5 text-[10px] uppercase text-accent">admin</span>}
              {r.is_system && <span className="rounded bg-bg-4 px-1.5 text-[10px] uppercase text-fg-dim">sistema</span>}
              <span className="ml-auto flex gap-0.5">
                {can('roles', 'update') && (
                  <button className="rounded px-1 text-xs text-fg-dim hover:bg-bg-3 hover:text-fg" title="Editar" onClick={() => setForm({ open: true, role: r })}>
                    ✎
                  </button>
                )}
                {can('roles', 'delete') && !r.is_system && (
                  <button className="rounded px-1 text-xs text-fg-dim hover:bg-bg-3 hover:text-danger" title="Excluir" onClick={() => setDeleting(r)}>
                    ✕
                  </button>
                )}
              </span>
            </div>
            <p className="mt-1 font-medium">{r.label}</p>
            {r.description && <p className="mt-0.5 text-sm text-fg-muted">{r.description}</p>}
            <p className="mt-2 text-xs text-fg-dim">
              {r.users ?? 0} usuário(s)
              {!r.is_admin && (
                <>
                  {' · '}
                  <NavLink to={`/settings/permissions?role=${r.id}`} className="text-accent hover:underline">
                    permissões →
                  </NavLink>
                </>
              )}
            </p>
          </li>
        ))}
      </ul>
      {form.open && (
        <RoleForm
          key={form.role?.id ?? 'new'}
          role={form.role}
          onClose={() => setForm({ open: false, role: null })}
          onSaved={() => {
            setForm({ open: false, role: null });
            void load();
          }}
        />
      )}
      <ConfirmDialog
        open={!!deleting}
        title="Excluir role"
        message={
          <>
            Excluir a role <strong>{deleting?.label}</strong>? Só é possível se nenhum usuário a estiver usando.
          </>
        }
        confirmLabel="Excluir"
        danger
        onCancel={() => setDeleting(null)}
        onConfirm={async () => {
          if (!deleting) return;
          try {
            await api.roles.remove(deleting.id);
            void load();
          } catch (err) {
            setError(err instanceof ApiError ? err.message : 'Erro ao excluir');
          }
          setDeleting(null);
        }}
      />
    </div>
  );
}

// ── Permissions matrix ───────────────────────────────────────────────────────

function PermissionsSection() {
  const { can } = useAuth();
  const [roles, setRoles] = useState<Role[]>([]);
  const [roleId, setRoleId] = useState<string>(() => new URLSearchParams(window.location.search).get('role') ?? '');
  const [matrix, setMatrix] = useState<ResourcePermissions[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [toggling, setToggling] = useState<string | null>(null);

  useEffect(() => {
    api.roles
      .list()
      .then((r) => {
        const editable = r.roles.filter((x) => !x.is_admin);
        setRoles(editable);
        setRoleId((cur) => (cur && editable.some((x) => x.id === cur) ? cur : (editable[0]?.id ?? '')));
      })
      .catch((err) => setError(err instanceof ApiError ? err.message : 'Erro ao carregar'));
  }, []);

  useEffect(() => {
    if (!roleId) return;
    setMatrix(null);
    api.roles
      .permissions(roleId)
      .then((r) => setMatrix(r.permissions))
      .catch((err) => setError(err instanceof ApiError ? err.message : 'Erro ao carregar'));
  }, [roleId]);

  const toggle = async (resource: string, action: PermissionAction) => {
    const key = `${resource}:${action}`;
    setToggling(key);
    try {
      const r = await api.roles.toggle(roleId, resource, action);
      setMatrix((m) => (m ?? []).map((row) => (row.resource === resource ? { ...row, [action]: r.granted } : row)));
      setError(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Erro ao alterar');
    } finally {
      setToggling(null);
    }
  };

  const editable = can('roles', 'update');
  const role = roles.find((r) => r.id === roleId);

  return (
    <div className="max-w-4xl">
      <div className="mb-4 flex items-end gap-4">
        <div>
          <h1 className="text-lg font-semibold">Permissões</h1>
          <p className="text-sm text-fg-muted">O que cada role pode fazer em cada recurso. Roles de administrador não aparecem aqui: têm acesso total.</p>
        </div>
        <select className="input ml-auto w-auto py-1 text-sm" value={roleId} onChange={(e) => setRoleId(e.target.value)}>
          {roles.map((r) => (
            <option key={r.id} value={r.id}>
              {r.label} ({r.name})
            </option>
          ))}
        </select>
      </div>
      {error && <p className="mb-3 text-sm text-danger">{error}</p>}
      {role?.description && <p className="mb-3 text-xs text-fg-dim">{role.description}</p>}
      {matrix && (
        <div className="overflow-x-auto rounded-lg border border-line bg-bg-2">
          <table className="w-full text-sm">
            <thead className="text-[11px] uppercase tracking-wide text-fg-dim">
              <tr className="border-b border-line">
                <th className="px-4 py-2 text-left">Recurso</th>
                {ACTIONS.map((a) => (
                  <th key={a} className="px-4 py-2 text-center">
                    {ACTION_LABELS[a]}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {matrix.map((row) => (
                <tr key={row.resource} className="border-b border-line last:border-0 hover:bg-bg-3">
                  <td className="px-4 py-2">
                    <span className="font-medium">{row.label}</span> <span className="font-mono text-[11px] text-fg-dim">{row.resource}</span>
                  </td>
                  {ACTIONS.map((a) => {
                    const key = `${row.resource}:${a}`;
                    return (
                      <td key={a} className="px-4 py-2 text-center">
                        <input
                          type="checkbox"
                          className="h-4 w-4 accent-[#4f8cff]"
                          checked={row[a]}
                          disabled={!editable || toggling === key}
                          onChange={() => void toggle(row.resource, a)}
                          aria-label={`${row.label}: ${ACTION_LABELS[a]}`}
                        />
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
