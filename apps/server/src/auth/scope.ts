import type { FastifyRequest } from 'fastify';
import type { Repositories } from '../db/repositories/index.js';
import type { Integration } from '../db/repositories/integrations.js';
import type { AiAccount, Machine, Project, Tab, Task, User } from '../db/repositories/types.js';
import { notFound } from '../lib/errors.js';
import { isAdmin } from './permissions.js';

/**
 * Data scope: machines (and everything under them) and integrations belong to a user. A request
 * sees only the rows of one owner — the signed-in user by default. Admins can switch that owner
 * with the "view as" cookie: another user's id (support/impersonation) or "*" for everything.
 * Non-admins never leave their own scope, whatever the cookie says.
 */

export const VIEW_AS_COOKIE = 'termhub_view_as';
export const VIEW_AS_ALL = '*';

export type ViewAs = { kind: 'self' } | { kind: 'all' } | { kind: 'user'; user: User };

export interface Scope {
  user: User;
  viewAs: ViewAs;
  /** owner filter for lists and lookups: a user id, or null = no filter (admin "all") */
  ownerId: string | null;
  /** owner assigned to rows created in this request */
  createAs: string;
}

declare module 'fastify' {
  interface FastifyRequest {
    /** set by the auth hook for authenticated requests */
    scope: Scope;
  }
}

export async function resolveScope(repos: Repositories, user: User, cookies: Record<string, string>): Promise<Scope> {
  const self: Scope = { user, viewAs: { kind: 'self' }, ownerId: user.id, createAs: user.id };
  const raw = cookies[VIEW_AS_COOKIE];
  if (!raw || raw === user.id) return self;
  if (!(await isAdmin(repos, user))) return self;
  if (raw === VIEW_AS_ALL) return { user, viewAs: { kind: 'all' }, ownerId: null, createAs: user.id };
  const target = await repos.users.findById(raw);
  if (!target) return self;
  return { user, viewAs: { kind: 'user', user: target }, ownerId: target.id, createAs: target.id };
}

/** Ownership-checked lookups: anything outside the scope answers 404, like a row that does not exist. */
export class Scoped {
  constructor(
    private repos: Repositories,
    readonly scope: Scope,
  ) {}

  owns(ownerId: string | null): boolean {
    return this.scope.ownerId === null || ownerId === this.scope.ownerId;
  }

  async machine(id: string): Promise<Machine> {
    const m = await this.repos.machines.findById(id);
    if (!m || !this.owns(m.owner_id)) throw notFound('Máquina não encontrada');
    return m;
  }

  async project(id: string): Promise<{ project: Project; machine: Machine }> {
    const project = await this.repos.projects.findById(id);
    if (!project) throw notFound('Projeto não encontrado');
    const machine = await this.repos.machines.findById(project.machine_id);
    if (!machine || !this.owns(machine.owner_id)) throw notFound('Projeto não encontrado');
    return { project, machine };
  }

  async tab(id: string): Promise<{ tab: Tab; project: Project; machine: Machine }> {
    const tab = await this.repos.tabs.findById(id);
    if (!tab) throw notFound('Tab não encontrada');
    const { project, machine } = await this.project(tab.project_id).catch(() => {
      throw notFound('Tab não encontrada');
    });
    return { tab, project, machine };
  }

  async task(id: string): Promise<{ task: Task; project: Project; machine: Machine }> {
    const task = await this.repos.tasks.findById(id);
    if (!task) throw notFound('Tarefa não encontrada');
    const { project, machine } = await this.project(task.project_id).catch(() => {
      throw notFound('Tarefa não encontrada');
    });
    return { task, project, machine };
  }

  async integration(id: string): Promise<Integration> {
    const i = await this.repos.integrations.findById(id);
    if (!i || !this.owns(i.owner_id)) throw notFound('Integração não encontrada');
    return i;
  }

  async aiAccount(id: string): Promise<{ account: AiAccount; machine: Machine }> {
    const account = await this.repos.aiAccounts.findById(id);
    if (!account) throw notFound('Conta não encontrada');
    const machine = await this.machine(account.machine_id).catch(() => {
      throw notFound('Conta não encontrada');
    });
    return { account, machine };
  }
}

export const scoped = (repos: Repositories, request: FastifyRequest): Scoped => new Scoped(repos, request.scope);
