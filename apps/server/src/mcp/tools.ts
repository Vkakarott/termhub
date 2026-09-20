import { z, type ZodRawShape } from 'zod';
import { TMUX_KEYS, tmuxKey } from '@termhub/agent-protocol';
import type { Action, Resource } from '../auth/permissions.js';
import type { ApiTokenScope } from '../auth/api-tokens.js';
import type { ControlContext } from '../control/context.js';
import { find, listAiAccounts, listMachines, listProjects, listTabs } from '../control/inventory.js';
import { readScreen, SCREEN_MAX_LINES, WAIT_MAX_SECONDS, waitForState } from '../control/screen.js';
import { closeTab, INPUT_MAX_CHARS, openTab, runCommand, RUN_MAX_SECONDS, sendInput, sendKey } from '../control/terminals.js';

export interface ToolDef {
  name: string;
  description: string;
  /** token scope that unlocks it */
  scope: ApiTokenScope;
  /** the user's grant it also needs */
  resource: Resource;
  action: Action;
  /** replaces the single resource:action check when the tool can work with any of several grants */
  allowedIf?(ctx: ControlContext): Promise<boolean>;
  /** how the refusal names the grant when `allowedIf` is set (after "da permissão ") */
  grantText?: string;
  input: ZodRawShape;
  run(ctx: ControlContext, args: Record<string, unknown>, signal: AbortSignal): Promise<unknown>;
}

const id = z.string().min(1).max(64);

/**
 * One place that turns raw tool arguments into validated ones — used by the route pre-check and by the SDK.
 * Only `undefined` (arguments omitted entirely) is treated as empty; `null` is a distinct, invalid value —
 * zod's object schema rejects it on its own, exactly as it would reject any other non-object.
 */
export function parseArgs(tool: ToolDef, args: unknown): { ok: true; value: Record<string, unknown> } | { ok: false } {
  const parsed = z.object(tool.input).safeParse(args === undefined ? {} : args);
  return parsed.success ? { ok: true, value: parsed.data as Record<string, unknown> } : { ok: false };
}

export const TOOLS: ToolDef[] = [
  {
    name: 'list_machines',
    description: 'List your machines: id, name, type (agent/local/ssh), OS, whether it is online now, and installed tools (claude, codex, tmux, …).',
    scope: 'read', resource: 'machines', action: 'read', input: {},
    run: (ctx) => listMachines(ctx),
  },
  {
    name: 'list_projects',
    description: 'List projects (a working directory on a machine). Archived ones are hidden unless include_archived.',
    scope: 'read', resource: 'projects', action: 'read',
    input: { machine_id: id.optional(), include_archived: z.boolean().optional() },
    run: (ctx, a) => listProjects(ctx, a as { machine_id?: string; include_archived?: boolean }),
  },
  {
    name: 'list_tabs',
    description: 'List the tabs of a project (or of every project of a machine): whether the tmux session is alive, what the tool in it is doing (working, waiting_input, waiting_permission, idle, error), its pending question, and the task linked to it.',
    scope: 'read', resource: 'terminals', action: 'read',
    input: { project_id: id.optional(), machine_id: id.optional() },
    run: (ctx, a) => listTabs(ctx, a as { project_id?: string; machine_id?: string }),
  },
  {
    name: 'list_ai_accounts',
    description: 'List the AI CLI accounts (Claude, Codex, Gemini, Antigravity) logged in on your machines: id, provider, label, machine.',
    scope: 'read', resource: 'ai_accounts', action: 'read',
    input: { machine_id: id.optional() },
    run: (ctx, a) => listAiAccounts(ctx, a as { machine_id?: string }),
  },
  {
    name: 'find',
    description: 'Resolve names to ids in one call — e.g. "MacBook Pro M4", "Hub Community", "pedrogoiania" — across machines, projects and AI accounts (case- and accent-insensitive, best matches first).',
    // find narrows the kinds it searches to what the user can read, so any one of them is enough
    scope: 'read', resource: 'projects', action: 'read',
    allowedIf: async (ctx) => (await Promise.all([ctx.can('machines', 'read'), ctx.can('projects', 'read'), ctx.can('ai_accounts', 'read')])).some(Boolean),
    grantText: 'de leitura de máquinas, projetos ou contas de IA',
    input: { query: z.string().min(1).max(200), kinds: z.array(z.enum(['machine', 'project', 'ai_account'])).optional() },
    run: (ctx, a) => find(ctx, a as { query: string; kinds?: ('machine' | 'project' | 'ai_account')[] }),
  },
  {
    name: 'read_screen',
    description: `Read the last lines of a terminal tab as plain text (default 200, max ${SCREEN_MAX_LINES}).`,
    scope: 'read', resource: 'terminals', action: 'read',
    input: { tab_id: id, lines: z.number().int().min(1).max(SCREEN_MAX_LINES).optional() },
    run: (ctx, a) => readScreen(ctx, a as { tab_id: string; lines?: number }),
  },
  {
    name: 'wait_for_state',
    description: `Wait until the tool in a tab stops working (it finished, asks something, or needs a permission), up to timeout_seconds (default 60, max ${WAIT_MAX_SECONDS}). A timeout is not an error: call again to keep waiting.`,
    scope: 'read', resource: 'terminals', action: 'read',
    input: { tab_id: id, timeout_seconds: z.number().int().min(1).max(WAIT_MAX_SECONDS).optional() },
    run: (ctx, a, signal) => waitForState(ctx, a as { tab_id: string; timeout_seconds?: number }, signal),
  },
  {
    name: 'open_tab',
    description: 'Open a terminal tab in a project and start its tmux session detached, so it keeps running with no browser attached.',
    scope: 'terminals', resource: 'terminals', action: 'write',
    input: { project_id: id, name: z.string().trim().min(1).max(60).optional() },
    run: (ctx, a) => openTab(ctx, a as { project_id: string; name?: string }),
  },
  {
    name: 'send_input',
    description: `Type text into a terminal tab (max ${INPUT_MAX_CHARS} chars) and press Enter unless enter is false. A tab waiting for a permission needs answering_permission: true.`,
    scope: 'terminals', resource: 'terminals', action: 'write',
    input: { tab_id: id, text: z.string().max(INPUT_MAX_CHARS), enter: z.boolean().optional(), answering_permission: z.boolean().optional() },
    run: (ctx, a) => sendInput(ctx, a as { tab_id: string; text: string; enter?: boolean; answering_permission?: boolean }),
  },
  {
    name: 'send_key',
    description: `Press one key in a terminal tab: ${TMUX_KEYS.join(', ')}.`,
    scope: 'terminals', resource: 'terminals', action: 'write',
    input: { tab_id: id, key: tmuxKey },
    run: (ctx, a) => sendKey(ctx, a as { tab_id: string; key: (typeof TMUX_KEYS)[number] }),
  },
  {
    name: 'run_command',
    description: `Type a command in a terminal tab, press Enter, wait for the tab to settle (default 30 s, max ${RUN_MAX_SECONDS}) and return the screen. There is no exit code: it is an interactive session. A aba não pode estar esperando uma permissão (waiting_permission) — responda com send_input ou send_key antes de rodar um comando.`,
    scope: 'terminals', resource: 'terminals', action: 'write',
    input: { tab_id: id, command: z.string().min(1).max(INPUT_MAX_CHARS), timeout_seconds: z.number().int().min(1).max(RUN_MAX_SECONDS).optional(), lines: z.number().int().min(1).max(SCREEN_MAX_LINES).optional() },
    run: (ctx, a, signal) => runCommand(ctx, a as { tab_id: string; command: string; timeout_seconds?: number; lines?: number }, signal),
  },
  {
    name: 'close_tab',
    description: 'Kill a terminal tab’s tmux session and remove the tab. Only tabs this token opened, unless force is true.',
    scope: 'terminals', resource: 'terminals', action: 'write',
    input: { tab_id: id, force: z.boolean().optional() },
    run: (ctx, a) => closeTab(ctx, a as { tab_id: string; force?: boolean }),
  },
];

/** Tools this token may call: its scope includes the tool's, and the user holds the tool's grant. */
export async function allowedTools(ctx: ControlContext, scopes: readonly ApiTokenScope[]): Promise<ToolDef[]> {
  const out: ToolDef[] = [];
  for (const t of TOOLS) if (scopes.includes(t.scope) && (await (t.allowedIf ? t.allowedIf(ctx) : ctx.can(t.resource, t.action)))) out.push(t);
  return out;
}

/** pt-BR answer for a tools/call this token may not make (spec §6: a tool error, not a JSON-RPC error). */
export function refusalMessage(name: string): string {
  const tool = TOOLS.find((t) => t.name === name);
  if (!tool) return `Ferramenta desconhecida: ${name.slice(0, 64)}`;
  return `Este token não pode usar a ferramenta ${name}: ela precisa do escopo \`${tool.scope}\` e da permissão ${tool.grantText ?? `${tool.resource}:${tool.action}`} na sua role`;
}
