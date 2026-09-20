import type { TmuxKey } from '@termhub/agent-protocol';
import { requireAgentVersion } from '../agent/errors.js';
import { agents } from '../agent/registry.js';
import { captureScreen } from '../agent/screen.js';
import type { Machine, Project, Tab } from '../db/repositories/types.js';
import { HttpError } from '../lib/errors.js';
import { killTmuxSession } from '../terminal/machine-exec.js';
import { ensureSession, INPUT_MAX_CHARS, sendKeyToSession, sendTextToSession, TERMINAL_RPC_MIN_AGENT_VERSION } from '../terminal/session-ops.js';
import { ControlError, type ControlContext } from './context.js';
import { SCREEN_DEFAULT_LINES, SCREEN_MAX_LINES, waitForState } from './screen.js';

/** Tabs one token may keep open at a time (spec §4.2): a runaway loop cannot bury the project in tabs. */
export const MAX_TABS_PER_TOKEN = 10;
export const RUN_DEFAULT_SECONDS = 30;
export const RUN_MAX_SECONDS = 90;
const SETTLE_POLL_MS = 1000;

const clamp = (v: number | undefined, def: number, max: number) => Math.max(1, Math.min(max, Math.trunc(v ?? def)));

const offline = () => new ControlError('MACHINE_OFFLINE', 'A máquina está offline: o termhub-agent dela não está conectado');

/** Online and new enough to answer the terminal RPCs — checked before anything is created or typed. */
function assertReady(machine: Machine): void {
  if (machine.type !== 'agent') return;
  if (!agents.isOnline(machine.id)) throw offline();
  requireAgentVersion(machine, TERMINAL_RPC_MIN_AGENT_VERSION); // HttpError 409 AGENT_OUTDATED
}

/** A terminal tab with a session name, on a machine that can answer right now. */
async function terminal(ctx: ControlContext, tabId: string): Promise<{ tab: Tab; project: Project; machine: Machine; session: string }> {
  const { tab, project, machine } = await ctx.scoped.tab(tabId);
  if (tab.kind !== 'terminal' || !tab.tmux_session) throw new ControlError('NOT_A_TERMINAL', 'Esta aba não é um terminal');
  assertReady(machine);
  return { tab, project, machine, session: tab.tmux_session };
}

/** Opens a tab and starts its tmux session detached, so it is alive without a browser attached. */
export async function openTab(ctx: ControlContext, input: { project_id: string; name?: string }): Promise<{ tab_id: string; name: string; project_id: string; tmux_session: string | null; created: boolean }> {
  const { project, machine } = await ctx.scoped.project(input.project_id);
  assertReady(machine);

  if (ctx.token) {
    const open = await ctx.repos.tabs.countOpenByToken(ctx.token.id);
    if (open >= MAX_TABS_PER_TOKEN) {
      throw new ControlError('TAB_LIMIT', `Este token já tem ${open} abas abertas (limite de ${MAX_TABS_PER_TOKEN}): feche alguma com close_tab antes de abrir outra`);
    }
  }

  const existing = await ctx.repos.tabs.listByProject(project.id);
  const name = input.name?.trim() || `Terminal ${existing.filter((t) => t.kind === 'terminal').length + 1}`;
  const tab = await ctx.repos.tabs.create(project.id, name, { created_by_token_id: ctx.token?.id ?? null });

  try {
    const { created } = await ensureSession(machine, tab.tmux_session as string, project.cwd);
    return { tab_id: tab.id, name: tab.name, project_id: project.id, tmux_session: tab.tmux_session, created };
  } catch (e) {
    // The tab is kept on purpose (spec §4.4): the error carries its id so the screen can be inspected.
    // The original code travels with it, so the audit row says what actually failed.
    const code = e instanceof ControlError || e instanceof HttpError ? (e.code ?? 'SESSION_FAILED') : 'SESSION_FAILED';
    throw new ControlError(code, `A aba ${tab.id} foi criada, mas a sessão tmux não subiu: ${e instanceof Error ? e.message : 'erro desconhecido'}`);
  }
}

/** Types text into the tab. `enter` defaults to true: the point is almost always to submit it. */
export async function sendInput(ctx: ControlContext, input: { tab_id: string; text: string; enter?: boolean; answering_permission?: boolean }): Promise<{ tab_id: string; sent: true }> {
  if (input.text.length > INPUT_MAX_CHARS) throw new ControlError('TEXT_TOO_LONG', `Texto longo demais: ${input.text.length} caracteres, máximo ${INPUT_MAX_CHARS}`);
  const { tab, project, machine, session } = await terminal(ctx, input.tab_id);
  if (tab.state === 'waiting_permission' && !input.answering_permission) {
    throw new ControlError('WAITING_PERMISSION', `Esta aba está esperando uma permissão: "${tab.state_text ?? 'pergunta não registrada'}". Se a sua resposta é para essa pergunta, repita com answering_permission: true.`);
  }
  await ensureSession(machine, session, project.cwd);
  await sendTextToSession(machine, session, input.text, input.enter ?? true);
  return { tab_id: tab.id, sent: true };
}

/** Presses one key from the closed list in the tab. */
export async function sendKey(ctx: ControlContext, input: { tab_id: string; key: TmuxKey }): Promise<{ tab_id: string; key: TmuxKey; sent: true }> {
  const { tab, project, machine, session } = await terminal(ctx, input.tab_id);
  await ensureSession(machine, session, project.cwd);
  await sendKeyToSession(machine, session, input.key);
  return { tab_id: tab.id, key: input.key, sent: true };
}

/**
 * Types a command, presses Enter and comes back with the screen once the tab settles. There is no
 * exit code — this is an interactive session, not a process runner. A command still running when the
 * timeout hits is not an error: the screen comes back with `timed_out: true`.
 */
export async function runCommand(
  ctx: ControlContext,
  input: { tab_id: string; command: string; timeout_seconds?: number; lines?: number },
  signal?: AbortSignal,
): Promise<{ tab_id: string; state: string | null; timed_out: boolean; lines: number; text: string }> {
  const { tab, project, machine, session } = await terminal(ctx, input.tab_id);
  if (input.command.length > INPUT_MAX_CHARS) throw new ControlError('TEXT_TOO_LONG', `Comando longo demais: ${input.command.length} caracteres, máximo ${INPUT_MAX_CHARS}`);
  const timeoutMs = clamp(input.timeout_seconds, RUN_DEFAULT_SECONDS, RUN_MAX_SECONDS) * 1000;
  const lines = clamp(input.lines, SCREEN_DEFAULT_LINES, SCREEN_MAX_LINES);

  await ensureSession(machine, session, project.cwd);
  await sendTextToSession(machine, session, input.command, true);

  const deadline = Date.now() + timeoutMs;
  let timedOut = false;
  let state: string | null = null;

  if (tab.state !== null) {
    // The machine has monitor hooks: the tool itself reports when it stopped working.
    const waited = await waitForState(ctx, { tab_id: tab.id, timeout_seconds: Math.ceil(timeoutMs / 1000) }, signal);
    timedOut = waited.timed_out;
    state = waited.state;
  } else {
    // No hooks: settle on the screen instead — two identical captures in a row mean nothing is moving.
    let previous: string | null = null;
    for (;;) {
      if (signal?.aborted) break;
      const now = await captureScreen(machine, session, lines);
      if (previous !== null && now === previous) break;
      previous = now;
      if (Date.now() + SETTLE_POLL_MS >= deadline) {
        timedOut = true;
        break;
      }
      await new Promise((r) => setTimeout(r, SETTLE_POLL_MS));
    }
  }

  return { tab_id: tab.id, state, timed_out: timedOut, lines, text: await captureScreen(machine, session, lines) };
}

/** Kills the tab's session and removes it. Only tabs this token opened, unless `force`. */
export async function closeTab(ctx: ControlContext, input: { tab_id: string; force?: boolean }): Promise<{ tab_id: string; killed: boolean }> {
  const { tab, machine } = await ctx.scoped.tab(input.tab_id);
  if (!input.force && ctx.token && tab.created_by_token_id !== ctx.token.id) {
    throw new ControlError('NOT_YOURS', 'Esta aba não foi aberta por este token: repita com force: true se quer fechá-la mesmo assim');
  }
  let killed = false;
  if (tab.tmux_session) {
    try {
      killed = await killTmuxSession(machine, tab.tmux_session);
    } catch {
      // An unreachable machine must not leave the tab behind; the row goes either way.
      killed = false;
    }
  }
  await ctx.repos.tabs.delete(tab.id);
  return { tab_id: tab.id, killed };
}
