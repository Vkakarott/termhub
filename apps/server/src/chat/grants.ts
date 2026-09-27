import type { z } from 'zod';
import type { chatGrantListQuery } from '@termhub/mobile-api';
import type { ChatAction } from '../db/repositories/chat-actions.js';
import { describeGrantList, describeGrants, describeProjectGrants, type ChatGrantListItem, type ChatGrantView, type ChatProjectGrantView } from '../db/repositories/chat-actions-view.js';
import { GRANT_LIST_MAX, type GrantCursor } from '../db/repositories/chat-grants.js';
import type { Repositories } from '../db/repositories/index.js';
import { conflict, HttpError, notFound } from '../lib/errors.js';
import { boardProjectOf } from './board-project.js';
import { chatBus } from './bus.js';
import { boardGrantable, grantable, GRANTABLE_TOOL } from './gate.js';

/**
 * "Permitir sempre nesta aba" is only for what the gate will honour (`grantable`): checked on the row
 * as the user sees it, before anything is decided (and, on the phone, before the PIN challenge is
 * spent), so a refused request changes nothing. Owner-scoped: another user's row is a 404.
 */
export async function assertGrantableAction(repos: Repositories, userId: string, actionId: string): Promise<ChatAction> {
  const row = await repos.chatActions.findByIdForUser(actionId, userId);
  if (!row) throw notFound('Ação não encontrada');
  if (row.status !== 'pending') throw conflict('Esta ação já foi decidida');
  if (!grantable(row.tool, (row.args ?? {}) as Record<string, unknown>)) throw new HttpError(400, 'Só dá para permitir sempre o envio de texto para uma aba', 'GRANT_NOT_ALLOWED');
  return row;
}

/** Trusts the tab of an action the user just approved, and tells every open screen (web and phone).
 * Created before the decision is re-injected, so the injected sentence can mention it. */
export async function grantTab(repos: Repositories, userId: string, action: ChatAction): Promise<ChatGrantView> {
  if (!action.tab_id) throw new HttpError(400, 'Só dá para permitir sempre o envio de texto para uma aba', 'GRANT_NOT_ALLOWED');
  const created = await repos.chatGrants.grant({ conversation_id: action.conversation_id, tab_id: action.tab_id, tool: GRANTABLE_TOOL, source_action_id: action.id, granted_by: userId });
  const [grant] = await describeGrants(repos, [created], userId);
  chatBus.publish({ type: 'grant', user_id: userId, conversation_id: action.conversation_id, grant });
  return grant;
}

const PROJECT_GRANT_NOT_ALLOWED = () => new HttpError(400, 'Só dá para permitir sempre neste projeto ações de quadro de um projeto seu', 'GRANT_NOT_ALLOWED');

/** "Permitir sempre neste projeto" only for a pending board card whose project resolves (spec 2026-09-26
 * project grant §5): checked before anything is decided, and before the phone's PIN challenge is spent.
 * Resolved with the caller's own user id, exactly as the gate does — never a "view as" owner id — so
 * the button is accepted for exactly the grants the gate will honour. */
export async function assertProjectGrantableAction(repos: Repositories, userId: string, actionId: string): Promise<{ action: ChatAction; projectId: string }> {
  const row = await repos.chatActions.findByIdForUser(actionId, userId);
  if (!row) throw notFound('Ação não encontrada');
  if (row.status !== 'pending') throw conflict('Esta ação já foi decidida');
  if (!boardGrantable(row.tool)) throw PROJECT_GRANT_NOT_ALLOWED();
  const projectId = await boardProjectOf(repos, userId, row.tool, (row.args ?? {}) as Record<string, unknown>);
  if (!projectId) throw PROJECT_GRANT_NOT_ALLOWED();
  return { action: row, projectId };
}

/** Trusts the project of an action the user just approved, and tells every open screen (web and phone).
 * Created before the decision is re-injected, so the injected sentence can mention it. */
export async function grantProject(repos: Repositories, userId: string, action: ChatAction, projectId: string): Promise<ChatProjectGrantView> {
  const created = await repos.chatProjectGrants.grant({ conversation_id: action.conversation_id, project_id: projectId, source_action_id: action.id, granted_by: userId });
  const [grant] = await describeProjectGrants(repos, [created], userId);
  chatBus.publish({ type: 'project_grant', user_id: userId, conversation_id: action.conversation_id, grant });
  return grant;
}

/** The conversation's project grants still in force, as `GET /chat` (web and phone) returns them. */
export async function activeProjectGrants(repos: Repositories, userId: string, conversationId: string): Promise<ChatProjectGrantView[]> {
  return describeProjectGrants(repos, await repos.chatProjectGrants.listActive(conversationId), userId);
}

/** "Revogar", either kind: tab grants first, then project grants (ids never collide). 404 unknown or
 * not this user's, 409 already revoked. */
export async function revokeGrant(repos: Repositories, userId: string, grantId: string): Promise<ChatGrantView | ChatProjectGrantView> {
  const tab = await repos.chatGrants.revoke(grantId, userId);
  if (tab) {
    chatBus.publish({ type: 'grant_revoked', user_id: userId, conversation_id: tab.conversation_id, grant_id: tab.id });
    return (await describeGrants(repos, [tab], userId))[0];
  }
  const project = await repos.chatProjectGrants.revoke(grantId, userId);
  if (project) {
    chatBus.publish({ type: 'project_grant_revoked', user_id: userId, conversation_id: project.conversation_id, grant_id: project.id });
    return (await describeProjectGrants(repos, [project], userId))[0];
  }
  const existing = (await repos.chatGrants.findByIdForUser(grantId, userId)) ?? (await repos.chatProjectGrants.findByIdForUser(grantId, userId));
  throw existing ? conflict('Esta permissão já foi revogada') : notFound('Permissão não encontrada');
}

/** The conversation's grants still in force, as `GET /chat` (web and phone) returns them. */
export async function activeGrants(repos: Repositories, userId: string, conversationId: string): Promise<ChatGrantView[]> {
  return describeGrants(repos, await repos.chatGrants.listActive(conversationId), userId);
}

const INVALID_CURSOR = () => new HttpError(400, 'Cursor inválido', 'INVALID_CURSOR');

/** Opaque to clients: base64url of `<created_at ISO>|<id>`. */
export const encodeGrantCursor = (c: GrantCursor): string => Buffer.from(`${c.created_at}|${c.id}`, 'utf8').toString('base64url');

/** The inverse, strictly: anything that is not exactly what `encodeGrantCursor` makes is a 400, never an
 * unfiltered page. */
export function decodeGrantCursor(s: string): GrantCursor {
  const raw = Buffer.from(s, 'base64url').toString('utf8');
  const sep = raw.indexOf('|');
  if (sep <= 0) throw INVALID_CURSOR();
  const created_at = raw.slice(0, sep);
  const id = raw.slice(sep + 1);
  const t = Date.parse(created_at);
  if (!id || id.length > 64 || !Number.isFinite(t) || new Date(t).toISOString() !== created_at) throw INVALID_CURSOR();
  return { created_at, id };
}

/** "Abas confiáveis" (spec 2026-09-26 §3.3): one page of this user's grants, web and phone alike.
 * `active` is never paged — the repository caps it at `GRANT_LIST_MAX` on its own, and this always
 * asks for that same cap rather than the query's `limit`, so the query's default (50) can never
 * silently truncate the active list. */
export async function listGrants(repos: Repositories, userId: string, query: z.infer<typeof chatGrantListQuery>, now = new Date()): Promise<{ grants: ChatGrantListItem[]; next_cursor: string | null }> {
  const cursor = query.cursor ? decodeGrantCursor(query.cursor) : null;
  const limit = query.state === 'active' ? GRANT_LIST_MAX : query.limit;
  const { grants, next } = await repos.chatGrants.listForUser(userId, { state: query.state, cursor, limit }, now);
  return { grants: await describeGrantList(repos, grants, userId, now), next_cursor: next ? encodeGrantCursor(next) : null };
}
