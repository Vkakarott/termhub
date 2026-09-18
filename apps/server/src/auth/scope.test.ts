import { beforeEach, describe, expect, it } from 'vitest';
import type { Repositories } from '../db/repositories/index.js';
import type { User } from '../db/repositories/types.js';
import { invalidatePermissionCache } from './permissions.js';
import { resolveScope, Scoped, VIEW_AS_ALL, VIEW_AS_COOKIE } from './scope.js';

const user = (id: string, roleId: string): User => ({ id, email: `${id}@x.com`, name: id, avatar_url: null, password_hash: null, google_id: null, role: 'member', role_id: roleId, invited_at: null, last_login_at: null, created_at: '' });
const admin = user('adm', 'role_admin');
const alice = user('alice', 'role_auth');
const bob = user('bob', 'role_auth');

/** Two machines (alice's m1 with project p1/tab t1/task k1, bob's m2) and one integration each. */
function fakeRepos(): Repositories {
  const users = [admin, alice, bob];
  const roles = { role_admin: { id: 'role_admin', is_admin: true }, role_auth: { id: 'role_auth', is_admin: false } };
  const machines = [
    { id: 'm1', owner_id: 'alice' },
    { id: 'm2', owner_id: 'bob' },
    { id: 'm3', owner_id: null },
  ];
  const projects = [{ id: 'p1', machine_id: 'm1' }];
  const tabs = [{ id: 't1', project_id: 'p1' }];
  const tasks = [{ id: 'k1', project_id: 'p1' }];
  const integrations = [{ id: 'i1', owner_id: 'alice' }];
  const accounts = [{ id: 'a1', machine_id: 'm2' }];
  const find = <T extends { id: string }>(rows: T[]) => async (id: string) => rows.find((r) => r.id === id);
  return {
    users: { findById: find(users) },
    roles: { findById: async (id: string) => (roles as Record<string, unknown>)[id], permissionsOf: async () => [] },
    machines: { findById: find(machines) },
    projects: { findById: find(projects) },
    tabs: { findById: find(tabs) },
    tasks: { findById: find(tasks) },
    integrations: { findById: find(integrations) },
    aiAccounts: { findById: find(accounts) },
  } as unknown as Repositories;
}

describe('resolveScope', () => {
  beforeEach(() => invalidatePermissionCache());

  it('defaults to the user itself', async () => {
    const s = await resolveScope(fakeRepos(), alice, {});
    expect(s.ownerId).toBe('alice');
    expect(s.createAs).toBe('alice');
    expect(s.viewAs).toEqual({ kind: 'self' });
  });

  it('ignores the view-as cookie for non-admins', async () => {
    const repos = fakeRepos();
    expect((await resolveScope(repos, alice, { [VIEW_AS_COOKIE]: 'bob' })).ownerId).toBe('alice');
    expect((await resolveScope(repos, alice, { [VIEW_AS_COOKIE]: VIEW_AS_ALL })).ownerId).toBe('alice');
  });

  it('lets admins view as another user, as all, and falls back on unknown ids', async () => {
    const repos = fakeRepos();
    const asBob = await resolveScope(repos, admin, { [VIEW_AS_COOKIE]: 'bob' });
    expect(asBob.ownerId).toBe('bob');
    expect(asBob.createAs).toBe('bob');
    expect(asBob.viewAs).toMatchObject({ kind: 'user', user: { id: 'bob' } });
    const all = await resolveScope(repos, admin, { [VIEW_AS_COOKIE]: VIEW_AS_ALL });
    expect(all.ownerId).toBeNull();
    expect(all.createAs).toBe('adm');
    expect((await resolveScope(repos, admin, { [VIEW_AS_COOKIE]: 'ghost' })).ownerId).toBe('adm');
  });
});

describe('Scoped', () => {
  const repos = fakeRepos();
  const as = (ownerId: string | null) => new Scoped(repos, { user: alice, viewAs: { kind: 'self' }, ownerId, createAs: ownerId ?? 'adm' });

  it('resolves rows of the owner and everything under their machines', async () => {
    const s = as('alice');
    expect((await s.machine('m1')).id).toBe('m1');
    expect((await s.project('p1')).machine.id).toBe('m1');
    expect((await s.tab('t1')).project.id).toBe('p1');
    expect((await s.task('k1')).machine.id).toBe('m1');
    expect((await s.integration('i1')).id).toBe('i1');
  });

  it("answers 404 for another user's rows, orphans and missing ids alike", async () => {
    const s = as('bob');
    for (const p of [s.machine('m1'), s.machine('m3'), s.machine('nope'), s.project('p1'), s.tab('t1'), s.task('k1'), s.integration('i1')]) {
      await expect(p).rejects.toMatchObject({ statusCode: 404 });
    }
    expect((await s.aiAccount('a1')).machine.id).toBe('m2');
    await expect(as('alice').aiAccount('a1')).rejects.toMatchObject({ statusCode: 404 });
  });

  it('sees everything with a null owner filter (admin "all")', async () => {
    const s = as(null);
    expect((await s.machine('m1')).id).toBe('m1');
    expect((await s.machine('m3')).id).toBe('m3');
    expect((await s.aiAccount('a1')).account.id).toBe('a1');
  });
});
