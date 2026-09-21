/**
 * The gate at the MCP boundary (spec §5.2): on a gated token — the concierge's, never a person's own
 * — a write is a question to the user, not an action. The HTTP call never waits for the answer, since
 * nginx cuts /mcp at 120 s and a blue/green deploy would lose the question: it returns at once saying
 * the action is pending, and the row in `chat_actions` is what remembers. When the user confirms, the
 * CLI session is told to repeat the call, and *that* arrival executes it.
 */
import { ControlError, type ControlContext } from '../control/context.js';
import type { ChatAction, ChatActionClass } from '../db/repositories/chat-actions.js';
import type { Tab } from '../db/repositories/types.js';
import { HttpError } from '../lib/errors.js';
import { chatBus } from './bus.js';
import { actionClass, gateDecision, idempotencyKeyFor } from './gate.js';

/** What the gate did: the tool's own value, or a pt-BR error for the caller to answer with. The
 * error's `code` is what the existing per-call audit row records; the gate writes no audit row. */
export type GateOutcome = { ok: true; value: unknown } | { ok: false; code: string; message: string };

export interface GatedCall {
  /** Only `gated` matters here: whose token it is decides whether anything is mediated at all. */
  token: { gated: boolean };
  tool: string;
  args: Record<string, unknown>;
  /** The tool call itself, already scope-checked and argument-validated by the caller. */
  run(): Promise<unknown>;
}

const PENDING = (tool: string) =>
  `Ação pendente de confirmação: o usuário precisa aprovar a ferramenta ${tool} no chat e nada foi executado. Não repita a chamada, não tente outro caminho e não faça mais nada: diga a ele que está aguardando a confirmação e pare. Quando ele confirmar, você será avisado e poderá repetir esta mesma chamada.`;

const WAITING: GateOutcome = {
  ok: false,
  code: 'CONFIRMATION_WAITING',
  message:
    'Esta ação ainda está aguardando a confirmação do usuário no chat: a pergunta já foi enviada e nada foi executado. Não repita a chamada: diga a ele que está esperando e pare.',
};

/**
 * A parallel arrival of the same approved proposal that lost the claim: another call already owns the
 * execution. Deliberately the same `CONFIRMATION_WAITING` outcome as a question still on screen —
 * what the model must do is identical, stop and wait — with wording that says which of the two it is.
 */
const ALREADY_CLAIMED: GateOutcome = {
  ok: false,
  code: 'CONFIRMATION_WAITING',
  message:
    'Uma chamada idêntica que chegou antes já está executando esta ação, então esta não executou nada. Não repita a chamada: espere o resultado da primeira e siga a partir dele.',
};

const REFUSED: GateOutcome = {
  ok: false,
  code: 'CONFIRMATION_DENIED',
  message:
    'O usuário recusou esta ação no chat, então ela não será executada. Não tente de novo nem por outro caminho: explique a ele o que ficou sem fazer e, se houver, proponha uma alternativa diferente.',
};

/**
 * How long a "no" keeps refusing the identical proposal. What a denial has to defend against is the
 * immediate retry — a model told no that asks again three times in the same turn, wearing the user
 * down and burning quota — and that risk lives in minutes, not for ever: after that the user may well
 * have changed their mind, and a permanent refusal would leave them no way to say so. A question the
 * user never answered (`expired`) is not a "no" at all, and is simply asked again.
 *
 * Scoping this to the assistant turn would be the better rule, since the retry is a within-turn
 * behaviour, but it needs the runtime to know which message is current and a call carrying only a
 * token has no such plumbing. A clock window is cruder and entirely predictable, which is the right
 * trade until that plumbing exists.
 */
const DENIAL_HOLDS_MS = 15 * 60 * 1000;

/** The user's "no" while it still holds. An older one is history: the same proposal is asked again. */
async function denialInForce(ctx: ControlContext, conversationId: string, key: string): Promise<ChatAction | undefined> {
  const row = await ctx.repos.chatActions.findDeniedByKey(conversationId, key);
  if (!row) return undefined;
  const decidedAt = Date.parse(row.decided_at ?? row.created_at);
  return Number.isFinite(decidedAt) && Date.now() - decidedAt < DENIAL_HOLDS_MS ? row : undefined;
}

const TAB_GONE = (tabId: string) => ({
  code: 'TAB_GONE',
  message: `A aba ${tabId} não existe mais, então a confirmação que o usuário deu para esta ação não vale mais e nada foi executado. Veja as abas com list_tabs e proponha a ação de novo se ainda fizer sentido.`,
});

const TAB_WAITING_PERMISSION = (tabId: string) => ({
  code: 'WAITING_PERMISSION',
  message: `A aba ${tabId} passou a esperar uma permissão enquanto a confirmação estava pendente: digitar agora responderia essa pergunta, não o que o usuário confirmou. Nada foi executado e a confirmação não vale mais. Leia a tela com read_screen e proponha a ação de novo.`,
});

const TAB_PROMPT_CHANGED = (tabId: string) => ({
  code: 'PROMPT_CHANGED',
  message: `A aba ${tabId} está esperando outra permissão, pedida depois da pergunta que o usuário confirmou: responder agora aceitaria algo que ele nunca viu. Nada foi executado e a confirmação não vale mais. Leia a tela com read_screen e proponha a ação de novo.`,
});

/** What the action targets, for the chat's card and for re-validating an approval. Ids only: a value
 * of another shape is not an id and is dropped rather than stored. */
const targetId = (v: unknown) => (typeof v === 'string' && v.length >= 1 && v.length <= 64 ? v : null);
const targetOf = (args: Record<string, unknown>) => ({
  machine_id: targetId(args.machine_id),
  project_id: targetId(args.project_id),
  tab_id: targetId(args.tab_id),
});

/**
 * Tools that type free text at the prompt — exactly what must not land in a permission dialog.
 * `send_key`, and `send_input` with `answering_permission`, are how a pending permission is meant to
 * be answered (the tools' own contract), so for those a tab waiting on a permission is not stale.
 */
const typesFreeText = (call: GatedCall) => call.tool === 'run_command' || (call.tool === 'send_input' && call.args.answering_permission !== true);

/**
 * Whether the permission the tab is asking for now is a different one from the one the user saw when
 * they confirmed. `TabsRepository.recordEvent` treats every `waiting_permission` as a fresh ask and
 * bumps `state_at` for it, so a `state_at` later than the question's `created_at` is another prompt:
 * the first was answered and a second appeared while the approval waited. Without this, an approved
 * "press Enter" could accept a dialog nobody ever read.
 */
function promptChangedSince(tab: Tab, row: ChatAction): boolean {
  const askedAt = Date.parse(tab.state_at ?? '');
  const confirmed = Date.parse(row.created_at);
  return Number.isFinite(askedAt) && Number.isFinite(confirmed) && askedAt > confirmed;
}

/**
 * An approval is a snapshot of the moment the user gave it. Between the question and the keystroke
 * the tab can be killed, or the tool in it can start asking for a permission — and then the approved
 * text would answer the wrong question. Either way the approval is spent: the row fails (never back
 * to pending) and the model is told why.
 */
async function staleApproval(ctx: ControlContext, call: GatedCall, row: ChatAction): Promise<{ code: string; message: string } | undefined> {
  if (!row.tab_id) return undefined;
  const tab = await ctx.repos.tabs.findById(row.tab_id);
  if (!tab) return TAB_GONE(row.tab_id);
  if (tab.state === 'waiting_permission') {
    if (typesFreeText(call)) return TAB_WAITING_PERMISSION(row.tab_id);
    // The exempted tools answer a permission on purpose — but only the one the user actually saw.
    if (promptChangedSince(tab, row)) return TAB_PROMPT_CHANGED(row.tab_id);
  }
  return undefined;
}

/** Runs an approved action and closes its row. Ruling R2: an offline machine, an agent too old, any
 * failure at all is a `failed` row carrying the real error code, and the error reaches the model —
 * never a new question, because asking again for what the machine cannot do is a loop with no exit. */
async function execute(ctx: ControlContext, call: GatedCall, row: ChatAction): Promise<GateOutcome> {
  const started = Date.now();
  // Claim the approval before anything else happens. Two identical calls can both read the same
  // `approved` row and, without a claim, both would act on one approval — one confirmation, two
  // commands on the user's machine. The conditional update lets exactly one through.
  if (!(await ctx.repos.chatActions.claimApproved(row.id))) return ALREADY_CLAIMED;
  const stale = await staleApproval(ctx, call, row);
  if (stale) {
    await ctx.repos.chatActions.markExecuted(row.id, false, stale.code, Date.now() - started);
    return { ok: false, ...stale };
  }
  try {
    const value = await call.run();
    await ctx.repos.chatActions.markExecuted(row.id, true, null, Date.now() - started);
    return { ok: true, value };
  } catch (err) {
    const code = err instanceof ControlError || err instanceof HttpError ? (err.code ?? 'ERROR') : 'INTERNAL';
    await ctx.repos.chatActions.markExecuted(row.id, false, code, Date.now() - started);
    throw err; // the caller turns it into the same answer any other failed tool call gets
  }
}

/** Records the proposal and puts the question in the chat. */
async function ask(ctx: ControlContext, call: GatedCall, conversationId: string, key: string, cls: ChatActionClass): Promise<GateOutcome> {
  const target = targetOf(call.args);
  let row: ChatAction;
  try {
    // `args` is the proposal exactly as the concierge made it — the command, the prompt, the target.
    row = await ctx.repos.chatActions.insertPending({ conversation_id: conversationId, tool: call.tool, args: call.args, class: cls, idempotency_key: key, ...target });
  } catch (err) {
    // Two calls of the same proposal can both read "no open row" before either inserts; the partial
    // unique index then refuses the loser. The winner's question is already in the chat, so this call
    // is simply waiting on it — asking again would put the same question twice in front of the user.
    // (An approval that landed in this same instant is picked up by the next arrival of the call.)
    if (await ctx.repos.chatActions.findOpenByKey(conversationId, key)) return WAITING;
    // Anything else is a real failure to record the proposal. The original error is deliberately not
    // rethrown: a rejected write carries the rejected data, so logging it upstream would put the
    // proposed command — the whole point of `args` — in a log line. The audit row's code is the signal.
    throw new ControlError(
      'ACTION_NOT_RECORDED',
      'Não foi possível registrar esta ação para o usuário confirmar, então nada foi executado. Avise que houve uma falha ao registrar o pedido e tente de novo em alguns segundos.',
    );
  }
  chatBus.publish({
    type: 'confirmation',
    user_id: ctx.scope.user.id,
    action_id: row.id,
    tool: row.tool,
    args: row.args,
    class: row.class,
    machine_id: row.machine_id,
    project_id: row.project_id,
    tab_id: row.tab_id,
  });
  return { ok: false, code: 'CONFIRMATION_PENDING', message: PENDING(call.tool) };
}

/** The gate itself: run the call, or answer why it did not run. */
export async function applyGate(ctx: ControlContext, call: GatedCall): Promise<GateOutcome> {
  const cls = actionClass(call.tool, call.args);
  // Reads are never gated, whatever the token; and a person's own MCP session acts unmediated —
  // they are the one calling, and asking them to confirm their own keystroke is nonsense.
  if (cls === 'read' || !call.token.gated) return { ok: true, value: await call.run() };

  // v1 (spec §2): a user has exactly one conversation, which is what lets a call that carries only a
  // token find the chat to ask in. Per-machine conversations will have to carry the id on the token.
  const conversation = await ctx.repos.chat.getOrCreateForUser(ctx.scope.user.id);
  const key = idempotencyKeyFor(conversation.id, call.tool, call.args);
  // The open row decides; with none, a recent "no" to the same proposal still does. Anything else —
  // no row, an executed one, a question left to expire, a denial older than the window — is asked.
  const row = (await ctx.repos.chatActions.findOpenByKey(conversation.id, key)) ?? (await denialInForce(ctx, conversation.id, key));

  const decision = gateDecision(row, cls);
  // `allow` and `refuse` only come back with a row (without one the decision is `ask`), so the guard
  // on `row` narrows the type rather than adding a branch of its own.
  if (!row || decision === 'ask') return ask(ctx, call, conversation.id, key, cls);
  if (decision === 'waiting') return WAITING;
  if (decision === 'allow') return execute(ctx, call, row);
  return REFUSED;
}
