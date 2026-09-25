// Notification routes (P§9, design spec §4.2 "Notifications"): history + read receipts, plus the
// two triggers the chat routes call when a confirmation is created or a run finishes.
import { randomId } from '../../../crypto/random';
import type { MockRouter } from '../router';
import { type MockAction, type MockNotification, type MockState, verifyAuth } from '../state';

const PAGE_SIZE = 50;

export function registerNotificationRoutes(router: MockRouter, state: MockState): void {
  router.route('GET', '/api/m/v1/notifications', (ctx) => {
    verifyAuth(state, { headers: ctx.headers, htm: 'GET', htu: ctx.htu, now: ctx.now() });

    // `state.notifications` is push()ed in creation order (oldest first); reversing gives the
    // newest-first order the route promises.
    const rows = [...state.notifications].reverse();
    const before = ctx.query.before;
    const startIndex = before ? rows.findIndex((row) => row.id === before) + 1 : 0;
    const page = rows.slice(startIndex, startIndex + PAGE_SIZE);
    const unread = state.notifications.filter((row) => row.read_at === null).length;
    const nextBefore = startIndex + page.length < rows.length ? (page[page.length - 1]?.id ?? null) : null;

    return { status: 200, body: { notifications: page, unread, next_before: nextBefore } };
  });

  router.route('POST', '/api/m/v1/notifications/:id/read', (ctx) => {
    verifyAuth(state, { headers: ctx.headers, htm: 'POST', htu: ctx.htu, now: ctx.now() });
    const row = state.notifications.find((n) => n.id === ctx.params.id);
    if (row && row.read_at === null) row.read_at = new Date(ctx.now()).toISOString();
    return { status: 200, body: {} };
  });
}

/** P§9's first trigger: one row per pending action created. The wording is fixed by the plan's
 * ruling (only the project name varies) rather than composed from the action's actual tab —
 * every confirmation the mock raises targets "a aba api (jarvis)" (see `handlers/chat.ts`). */
export function pushConfirmationNotification(state: MockState, now: number, action: MockAction, projectName: string | null): void {
  const body = projectName
    ? `O chat do projeto ${projectName} pediu confirmação para agir na aba api (jarvis).`
    : 'O chat geral pediu confirmação para agir.';
  const row: MockNotification = {
    id: randomId(10),
    kind: 'confirmation',
    title: 'termhub precisa de você',
    body,
    data: { kind: 'confirmation', conversation_id: action.conversation_id, project_id: action.project_id, action_id: action.id },
    created_at: new Date(now).toISOString(),
    read_at: null,
  };
  state.notifications.push(row);
}

/** P§9's second trigger: one row per finished run — success or `HOST_GONE`, both count as
 * "finished" (design spec §4.2's Notifications bullet says "every finished run", not "every
 * successful one"). */
export function pushReplyNotification(state: MockState, now: number, conversationId: string, projectId: string | null, projectName: string | null): void {
  const row: MockNotification = {
    id: randomId(10),
    kind: 'reply',
    title: projectName ? `Resposta pronta em ${projectName}` : 'Resposta pronta',
    body: projectName ? `O chat do projeto ${projectName} terminou de responder.` : 'O chat geral terminou de responder.',
    data: { kind: 'reply', conversation_id: conversationId, project_id: projectId },
    created_at: new Date(now).toISOString(),
    read_at: null,
  };
  state.notifications.push(row);
}
