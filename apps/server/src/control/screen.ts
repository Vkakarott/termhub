import { captureScreen } from '../agent/screen.js';
import { AgentOfflineError } from '../agent/registry.js';
import type { Tab, TabState } from '../db/repositories/types.js';
import { monitorBus } from '../monitor/bus.js';
import { ControlError, type ControlContext } from './context.js';

export const SCREEN_DEFAULT_LINES = 200;
export const SCREEN_MAX_LINES = 2000;
export const WAIT_DEFAULT_SECONDS = 60;
export const WAIT_MAX_SECONDS = 90;

const clamp = (v: number | undefined, def: number, max: number) => Math.max(1, Math.min(max, Math.trunc(v ?? def)));

/** Last lines of a terminal tab (plain text, as tmux shows them). Never logged. */
export async function readScreen(ctx: ControlContext, input: { tab_id: string; lines?: number }): Promise<{ tab_id: string; lines: number; text: string }> {
  const { tab, machine } = await ctx.scoped.tab(input.tab_id);
  if (tab.kind !== 'terminal' || !tab.tmux_session) throw new ControlError('NOT_A_TERMINAL', 'Esta aba não é um terminal');
  const lines = clamp(input.lines, SCREEN_DEFAULT_LINES, SCREEN_MAX_LINES);
  try {
    return { tab_id: tab.id, lines, text: await captureScreen(machine, tab.tmux_session, lines) };
  } catch (e) {
    if (e instanceof AgentOfflineError) throw new ControlError('MACHINE_OFFLINE', 'A máquina está offline: o termhub-agent dela não está conectado');
    throw e;
  }
}

export interface WaitResult {
  tab_id: string;
  state: TabState | null;
  state_text: string | null;
  state_at: string | null;
  timed_out: boolean;
  note?: string;
}

const result = (tab: Tab, timedOut: boolean): WaitResult => ({ tab_id: tab.id, state: tab.state, state_text: tab.state_text, state_at: tab.state_at, timed_out: timedOut });

/**
 * Waits until the tab's tool stops working (reported by its hooks) or the timeout. A timeout is a
 * normal answer (`timed_out: true`), not an error — call again to keep waiting. Aborting (client
 * gone) ends the wait the same way and always removes the bus listener.
 */
export async function waitForState(ctx: ControlContext, input: { tab_id: string; timeout_seconds?: number }, signal?: AbortSignal): Promise<WaitResult> {
  const { tab } = await ctx.scoped.tab(input.tab_id);
  if (tab.state === null) {
    return { ...result(tab, false), note: 'Aba sem monitor: os hooks não estão instalados nesta máquina (Máquina → Monitor). Use read_screen para ver o terminal.' };
  }
  if (tab.state !== 'working') return result(tab, false);

  const timeoutMs = clamp(input.timeout_seconds, WAIT_DEFAULT_SECONDS, WAIT_MAX_SECONDS) * 1000;
  return new Promise<WaitResult>((resolve) => {
    let last = tab;
    const finish = (r: WaitResult) => {
      unsubscribe();
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      resolve(r);
    };
    const unsubscribe = monitorBus.subscribe((change) => {
      if (change.tab.id !== tab.id) return;
      last = change.tab;
      if (change.tab.state !== 'working') finish(result(change.tab, false));
    });
    const timer = setTimeout(() => finish(result(last, true)), timeoutMs);
    const onAbort = () => finish(result(last, true));
    if (signal?.aborted) onAbort();
    else signal?.addEventListener('abort', onAbort, { once: true });
  });
}
