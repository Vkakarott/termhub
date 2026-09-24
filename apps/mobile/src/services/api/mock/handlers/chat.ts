// Chat routes (P§6, design spec §4.2 "Chat"/"Controls"): projects, the conversation payload,
// sending a message (`202` then a reply streamed over the socket), decisions and reset.
import { decisionProof } from '../../../crypto/pin';
import { randomId } from '../../../crypto/random';
import { mobileDecisionBody, mobileMessageBody, resetBody, setHostBody, type TChatEvent, type TChatHostState } from '../../contract';
import type { MockRouter } from '../router';
import { broadcast, countPinFailure, type MockAction, type MockConversation, type MockMessage, type MockState, verifyAuth, WireError } from '../state';
import { pushConfirmationNotification, pushReplyNotification } from './notifications';

const USER_ID = 'u1';

/** The fixed roster `GET chat/host/options` lists and `POST chat/host` validates against
 * (design spec §4.2 "Chat": "hostOptions lists two machines"). `m-hulk` has no accounts because
 * it is offline — the web/app never let you pick an account on a machine you cannot reach. */
const HOST_MACHINES = [
  { id: 'm-jarvis', name: 'jarvis', online: true, agentVersion: '0.4.4', accounts: [{ id: 'acc-1', label: 'Claude Pedro', configDir: null as string | null }] },
  { id: 'm-hulk', name: 'hulk', online: false, agentVersion: '0.4.3', accounts: [] as Array<{ id: string; label: string; configDir: string | null }> },
];

/** Derives `GET chat`/`POST chat/host`'s `host` from the conversation's own stored
 * `machine_id`/`ai_account_id` — defaulting to `m-jarvis`/no account when neither was ever set
 * (fixtures seed exactly that). An offline machine (`m-hulk`) answers `offline`; a chosen account
 * that no longer exists on the machine quietly falls back to `default`, same as never choosing
 * one — there is no wire error for that case in P§6. */
function hostFor(conversation: MockConversation): TChatHostState {
  const machineId = conversation.machine_id ?? 'm-jarvis';
  const machine = HOST_MACHINES.find((m) => m.id === machineId) ?? HOST_MACHINES[0]!;
  if (!machine.online) return { kind: 'offline', machine: { id: machine.id, name: machine.name } };

  const chosen = conversation.ai_account_id ? machine.accounts.find((a) => a.id === conversation.ai_account_id) : undefined;
  return {
    kind: 'ready',
    machine: { id: machine.id, name: machine.name },
    configDir: chosen?.configDir ?? null,
    account: chosen ? { kind: 'chosen', id: chosen.id, label: chosen.label } : { kind: 'default' },
    sessionAtStake: false,
  };
}

function conversationFor(state: MockState, projectId: string | null): MockConversation {
  const id = state.activeConversation.get(projectId);
  const conversation = id ? state.conversations.get(id) : undefined;
  if (!conversation) throw new WireError(404, 'NOT_FOUND', 'Conversa não encontrada.');
  return conversation;
}

function actionsFor(state: MockState, conversationId: string): MockAction[] {
  return [...state.actions.values()].filter((a) => a.conversation_id === conversationId);
}

// --- the canned reply and its streaming (ruling 3) ----------------------------------------------

interface AnswerOutcome {
  kind: 'normal' | 'confirmation' | 'error';
  text: string;
}

/** Canned answers keyed by keyword (brief's exact pt-BR texts). `erro` and `confirma` change the
 * shape of the run instead of just picking its text. */
function pickAnswer(text: string): AnswerOutcome {
  if (/erro/.test(text)) return { kind: 'error', text: '' };
  if (/confirma/.test(text)) {
    return { kind: 'confirmation', text: 'Preciso que você confirme essa ação — fico esperando sua aprovação antes de continuar.' };
  }
  if (/test|teste/.test(text)) return { kind: 'normal', text: 'Rodei `npm test` no jarvis: 1066 testes passaram, 137 pulados. Nada quebrou.' };
  if (/deploy/.test(text)) return { kind: 'normal', text: 'O último deploy foi há 2 h, verde. Quer que eu dispare outro?' };
  if (/status/.test(text)) return { kind: 'normal', text: 'Duas abas trabalhando, uma esperando você: a aba api pediu para rodar os testes.' };
  return { kind: 'normal', text: 'Entendi. Posso olhar as abas do projeto e te dizer o que está esperando você — quer que eu faça isso?' };
}

/** Splits `text` into 12-30 char pieces (ruling 3) — at least one, since every outcome above is
 * non-empty text (the `error` outcome never reaches this: it skips streaming entirely). */
function chunkText(text: string): string[] {
  const chunks: string[] = [];
  let i = 0;
  while (i < text.length) {
    const size = Math.min(text.length - i, 12 + Math.floor(Math.random() * 19));
    chunks.push(text.slice(i, i + size));
    i += size;
  }
  return chunks;
}

function createConfirmationAction(state: MockState, now: number, conversationId: string, projectId: string | null, projectName: string | null): MockAction {
  const action: MockAction = {
    id: randomId(10),
    conversation_id: conversationId,
    tool: 'send_input',
    args: {},
    class: 'write',
    status: 'pending',
    machine_id: projectId ? 'm-jarvis' : null,
    project_id: projectId,
    tab_id: projectId ? 't-api' : null,
    summary: projectId ? `digitar comando na aba api do projeto ${projectName}, no jarvis` : 'digitar comando no chat geral',
    created_at: new Date(now).toISOString(),
  };
  state.actions.set(action.id, action);
  return action;
}

function confirmationEvent(action: MockAction): TChatEvent {
  return {
    type: 'confirmation',
    user_id: USER_ID,
    conversation_id: action.conversation_id,
    action_id: action.id,
    tool: action.tool,
    args: action.args,
    class: action.class,
    machine_id: action.machine_id,
    project_id: action.project_id,
    tab_id: action.tab_id,
    summary: action.summary,
    created_at: action.created_at,
  };
}

interface StreamOptions {
  state: MockState;
  now: () => number;
  stepMs: number;
  conversationId: string;
  projectId: string | null;
  projectName: string | null;
  userMessageId: string;
  assistantMessageId: string;
  userText: string;
}

/** The `202` reply's follow-up: a `setTimeout` chain so every event is its own macrotask — user
 * message, empty assistant message, the confirmation (if any), the deltas, the final message
 * (ruling 3). `busy` is set synchronously so a `chatProjects` call right after the `202` already
 * sees it. */
function scheduleStream(o: StreamOptions): void {
  const step = (fn: () => void) => setTimeout(fn, o.stepMs);

  o.state.busyProjects.add(o.projectId);

  step(() => {
    const userMessage: MockMessage = {
      id: o.userMessageId,
      conversation_id: o.conversationId,
      role: 'user',
      text: o.userText,
      usage: null,
      error_code: null,
      created_at: new Date(o.now()).toISOString(),
    };
    o.state.messages.get(o.conversationId)?.push(userMessage);
    broadcast(o.state, { type: 'message', user_id: USER_ID, conversation_id: o.conversationId, message: userMessage });

    step(() => {
      const assistantMessage: MockMessage = {
        id: o.assistantMessageId,
        conversation_id: o.conversationId,
        role: 'assistant',
        text: '',
        usage: null,
        error_code: null,
        created_at: new Date(o.now()).toISOString(),
      };
      o.state.messages.get(o.conversationId)?.push(assistantMessage);
      broadcast(o.state, { type: 'message', user_id: USER_ID, conversation_id: o.conversationId, message: assistantMessage });

      const outcome = pickAnswer(o.userText);

      const finish = (finalText: string, errorCode: string | null) => {
        assistantMessage.text = finalText;
        assistantMessage.error_code = errorCode;
        broadcast(o.state, { type: 'message', user_id: USER_ID, conversation_id: o.conversationId, message: assistantMessage });
        const conversation = o.state.conversations.get(o.conversationId);
        if (conversation) conversation.last_message_at = assistantMessage.created_at;
        o.state.busyProjects.delete(o.projectId);
        pushReplyNotification(o.state, o.now(), o.conversationId, o.projectId, o.projectName);
      };

      if (outcome.kind === 'error') {
        step(() => finish('', 'HOST_GONE'));
        return;
      }

      if (outcome.kind === 'confirmation') {
        const action = createConfirmationAction(o.state, o.now(), o.conversationId, o.projectId, o.projectName);
        broadcast(o.state, confirmationEvent(action));
        pushConfirmationNotification(o.state, o.now(), action, o.projectName);
      }

      const chunks = chunkText(outcome.text);
      const emitChunk = (i: number) => {
        if (i >= chunks.length) {
          finish(outcome.text, null);
          return;
        }
        step(() => {
          broadcast(o.state, { type: 'delta', user_id: USER_ID, conversation_id: o.conversationId, message_id: o.assistantMessageId, delta: chunks[i]! });
          emitChunk(i + 1);
        });
      };
      emitChunk(0);
    });
  });
}

// --- routes ---------------------------------------------------------------------------------

export function registerChatRoutes(router: MockRouter, state: MockState, opts: { maxLatency: number }): void {
  const stepMs = Math.max(0, opts.maxLatency) / 2;

  router.route('GET', '/api/m/v1/chat/projects', (ctx) => {
    verifyAuth(state, { headers: ctx.headers, htm: 'GET', htu: ctx.htu, now: ctx.now() });
    const projects = [...state.projects.values()].map((project) => {
      const conversationId = state.activeConversation.get(project.id);
      const conversation = conversationId ? state.conversations.get(conversationId) : undefined;
      const pending = conversation ? actionsFor(state, conversation.id).filter((a) => a.status === 'pending').length : 0;
      return {
        id: project.id,
        name: project.name,
        key: project.key,
        busy: state.busyProjects.has(project.id),
        pending_confirmations: pending,
        last_message_at: conversation?.last_message_at ?? null,
      };
    });
    return { status: 200, body: { projects } };
  });

  router.route('GET', '/api/m/v1/chat', (ctx) => {
    verifyAuth(state, { headers: ctx.headers, htm: 'GET', htu: ctx.htu, now: ctx.now() });
    const projectId = ctx.query.project ?? null;
    const conversation = conversationFor(state, projectId);
    return {
      status: 200,
      body: {
        conversation,
        messages: state.messages.get(conversation.id) ?? [],
        actions: actionsFor(state, conversation.id),
        host: hostFor(conversation),
      },
    };
  });

  router.route('GET', '/api/m/v1/chat/host/options', (ctx) => {
    verifyAuth(state, { headers: ctx.headers, htm: 'GET', htu: ctx.htu, now: ctx.now() });
    return {
      status: 200,
      body: {
        machines: HOST_MACHINES.map((m) => ({
          id: m.id,
          name: m.name,
          online: m.online,
          agent_version: m.agentVersion,
          accounts: m.accounts.map((a) => ({ id: a.id, label: a.label, config_dir: a.configDir })),
        })),
      },
    };
  });

  router.route('POST', '/api/m/v1/chat/host', (ctx) => {
    verifyAuth(state, { headers: ctx.headers, htm: 'POST', htu: ctx.htu, now: ctx.now() });
    const body = setHostBody.parse(ctx.body);
    const machine = HOST_MACHINES.find((m) => m.id === body.machine_id);
    if (!machine) throw new WireError(404, 'MACHINE_NOT_FOUND', 'Máquina não encontrada.');

    // `client.ts`'s `setHost` carries no project targeting (no query, no `project_id` in the
    // body) — it always applies to the account-wide chat, the only conversation the app lets you
    // pick a host for (design spec §6: `HostSheet` is "for the account-wide chat"); every
    // project's conversation keeps the fixed `m-jarvis` fixtures give it.
    const conversation = conversationFor(state, null);
    conversation.machine_id = machine.id;
    conversation.ai_account_id = body.ai_account_id ?? null;

    return { status: 200, body: { conversation, host: hostFor(conversation) } };
  });

  router.route('POST', '/api/m/v1/chat/messages', (ctx) => {
    verifyAuth(state, { headers: ctx.headers, htm: 'POST', htu: ctx.htu, now: ctx.now() });
    const body = mobileMessageBody.parse(ctx.body);
    const projectId = body.project_id ?? null;
    const conversation = conversationFor(state, projectId);
    const project = projectId ? state.projects.get(projectId) : undefined;
    const userMessageId = randomId(10);
    const assistantMessageId = randomId(10);

    scheduleStream({
      state,
      now: ctx.now,
      stepMs,
      conversationId: conversation.id,
      projectId,
      projectName: project?.name ?? null,
      userMessageId,
      assistantMessageId,
      userText: body.text,
    });

    return { status: 202, body: { conversation_id: conversation.id, user_message_id: userMessageId, assistant_message_id: assistantMessageId } };
  });

  router.route('POST', '/api/m/v1/chat/reset', (ctx) => {
    verifyAuth(state, { headers: ctx.headers, htm: 'POST', htu: ctx.htu, now: ctx.now() });
    const body = resetBody.parse(ctx.body);
    const projectId = body.project_id ?? null;
    const previous = conversationFor(state, projectId);
    previous.archived_at = new Date(ctx.now()).toISOString();

    const conversation: MockConversation = {
      id: randomId(10),
      title: null,
      project_id: projectId,
      machine_id: 'm-jarvis',
      ai_account_id: null,
      archived_at: null,
      last_message_at: null,
    };
    state.conversations.set(conversation.id, conversation);
    state.messages.set(conversation.id, []);
    state.activeConversation.set(projectId, conversation.id);

    return { status: 200, body: { conversation } };
  });

  router.route('POST', '/api/m/v1/chat/actions/:id/decision', (ctx) => {
    const { device } = verifyAuth(state, { headers: ctx.headers, htm: 'POST', htu: ctx.htu, now: ctx.now() });
    const body = mobileDecisionBody.parse(ctx.body);
    const action = state.actions.get(ctx.params.id!);
    if (!action) throw new WireError(404, 'NOT_FOUND', 'Ação não encontrada.');
    // Checked before any PIN handling — even for `deny` (ruling 7) — so redeciding a settled
    // action never burns a PIN attempt.
    if (action.status !== 'pending') throw new WireError(409, 'ALREADY_DECIDED', 'Esta ação já foi decidida.');

    const now = ctx.now();

    if (body.decision === 'deny') {
      action.status = 'denied';
      broadcast(state, { type: 'decision', user_id: USER_ID, conversation_id: action.conversation_id, action_id: action.id, status: 'denied' });
      return { status: 200, body: {} };
    }

    // `approve` submits a PIN guess exactly like `session/token` does, so a device already locked
    // out is blocked the same way, without this attempt counting again.
    if (device.lockedUntil !== undefined && device.lockedUntil > now) {
      const retryAfter = Math.ceil((device.lockedUntil - now) / 1000);
      throw new WireError(423, 'DEVICE_LOCKED', 'Aparelho bloqueado por tentativas de PIN.', { retry_after: retryAfter });
    }

    const chal = state.challenges.get(body.challenge);
    const bound = !!chal && !chal.used && now <= chal.expiresAt && chal.deviceId === device.id && chal.purpose === 'decision' && chal.actionId === action.id;
    if (bound) chal!.used = true;

    const expectedProof = bound ? decisionProof(device.pinSecret, body.challenge, action.id) : null;
    if (!bound || body.pin_proof !== expectedProof) {
      const attemptsLeft = countPinFailure(state, device, now);
      throw new WireError(401, 'PIN_INVALID', 'PIN incorreto.', { attempts_left: attemptsLeft });
    }

    device.pinFailures = 0;
    action.status = 'approved';
    broadcast(state, { type: 'decision', user_id: USER_ID, conversation_id: action.conversation_id, action_id: action.id, status: 'approved' });
    return { status: 200, body: {} };
  });
}
