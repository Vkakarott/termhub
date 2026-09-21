/**
 * The gate at the MCP boundary (spec §5.2): on a gated token — the concierge's, never a person's own
 * — a write is a question to the user, not an action. The HTTP call never waits for the answer, since
 * nginx cuts /mcp at 120 s and a blue/green deploy would lose the question: it returns at once saying
 * the action is pending, and the row in `chat_actions` is what remembers. When the user confirms, the
 * CLI session is told to repeat the call, and *that* arrival executes it.
 */
import { ControlError, type ControlContext } from '../control/context.js';
import type { ChatAction, ChatActionClass } from '../db/repositories/chat-actions.js';
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

/** Spec §5.2 step 4: refused outright and asked-but-never-answered both mean "not authorised", but
 * the model has to explain the right one to the user. */
const REFUSED = (row: ChatAction): GateOutcome =>
  row.status === 'expired'
    ? {
        ok: false,
        code: 'CONFIRMATION_EXPIRED',
        message:
          'A confirmação desta ação expirou sem resposta do usuário, então nada foi executado e esta chamada não vale mais. Não repita a chamada: diga a ele que a pergunta expirou e espere o que ele decidir.',
      }
    : {
        ok: false,
        code: 'CONFIRMATION_DENIED',
        message:
          'O usuário recusou esta ação no chat, então ela não será executada. Não tente de novo nem por outro caminho: explique a ele o que ficou sem fazer e, se houver, proponha uma alternativa diferente.',
      };

const TAB_GONE = (tabId: string) => ({
  code: 'TAB_GONE',
  message: `A aba ${tabId} não existe mais, então a confirmação que o usuário deu para esta ação não vale mais e nada foi executado. Veja as abas com list_tabs e proponha a ação de novo se ainda fizer sentido.`,
});

const TAB_WAITING_PERMISSION = (tabId: string) => ({
  code: 'WAITING_PERMISSION',
  message: `A aba ${tabId} passou a esperar uma permissão enquanto a confirmação estava pendente: digitar agora responderia essa pergunta, não o que o usuário confirmou. Nada foi executado e a confirmação não vale mais. Leia a tela com read_screen e proponha a ação de novo.`,
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
 * An approval is a snapshot of the moment the user gave it. Between the question and the keystroke
 * the tab can be killed, or the tool in it can start asking for a permission — and then the approved
 * text would answer the wrong question. Either way the approval is spent: the row fails (never back
 * to pending) and the model is told why.
 */
async function staleApproval(ctx: ControlContext, call: GatedCall, row: ChatAction): Promise<{ code: string; message: string } | undefined> {
  if (!row.tab_id) return undefined;
  const tab = await ctx.repos.tabs.findById(row.tab_id);
  if (!tab) return TAB_GONE(row.tab_id);
  if (tab.state === 'waiting_permission' && typesFreeText(call)) return TAB_WAITING_PERMISSION(row.tab_id);
  return undefined;
}

/** Runs an approved action and closes its row. Ruling R2: an offline machine, an agent too old, any
 * failure at all is a `failed` row carrying the real error code, and the error reaches the model —
 * never a new question, because asking again for what the machine cannot do is a loop with no exit. */
async function execute(ctx: ControlContext, call: GatedCall, row: ChatAction): Promise<GateOutcome> {
  const started = Date.now();
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
    if (!(await ctx.repos.chatActions.findOpenByKey(conversationId, key))) throw err;
    return WAITING;
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
  // The open row decides; with none, a refusal of the same proposal still does.
  const row = (await ctx.repos.chatActions.findOpenByKey(conversation.id, key)) ?? (await ctx.repos.chatActions.findRefusedByKey(conversation.id, key));

  const decision = gateDecision(row, cls);
  // `allow` and `refuse` only come back with a row (without one the decision is `ask`), so the guard
  // on `row` narrows the type rather than adding a branch of its own.
  if (!row || decision === 'ask') return ask(ctx, call, conversation.id, key, cls);
  if (decision === 'waiting') return WAITING;
  if (decision === 'allow') return execute(ctx, call, row);
  return REFUSED(row);
}
