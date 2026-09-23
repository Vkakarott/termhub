import type { FastifyBaseLogger } from 'fastify';
import type { Repositories } from '../db/repositories/index.js';
import type { Tab } from '../db/repositories/types.js';
import { monitorBus } from './bus.js';
import { interpretHookEvent, type HookTool, type Interpreted } from './state.js';

export type IngestResult = { ok: true; tab: Tab } | { ok: false; reason: 'unknown_session' | 'ignored' };

/**
 * A hook fired on a machine: find the tab by its tmux session, interpret the payload, store
 * the event as the tab's state and tell the subscribers. Logs metadata only (never `text`).
 */
export async function ingestHookEvent(
  repos: Repositories,
  log: FastifyBaseLogger,
  input: { machineId: string; tool: HookTool; session: string; event: unknown },
): Promise<IngestResult> {
  const tab = await repos.tabs.findByTmuxSession(input.machineId, input.session);
  if (!tab) return { ok: false, reason: 'unknown_session' };
  const interpreted = interpretHookEvent(input.tool, input.event);
  if (!interpreted) return { ok: false, reason: 'ignored' };
  // A tool (or spinner verb) change on a tab already working is not a state change: the light path
  // moves only the activity and its verb (no event row) and still tells the subscribers. The script
  // already posts only on a change; the equality check here is a defensive no-op for anything else.
  if (interpreted.activity !== undefined && tab.state === 'working' && interpreted.kind === 'working') {
    const verb = interpreted.verb ?? null;
    if (tab.activity === interpreted.activity && tab.activity_verb === verb) return { ok: true, tab };
    // Nothing updated: the tab stopped working (or is gone) between the read above and this write —
    // the conditional UPDATE is what decides, not the row we read. The full path takes it from here.
    const updated = await repos.tabs.setActivity(tab.id, interpreted.activity, verb);
    if (updated) {
      const machine = await repos.machines.findById(tab.machine_id);
      // the verb came off the person's screen: only whether there was one is logged
      log.debug({ tabId: tab.id, machineId: machine?.id, activity: interpreted.activity, hasVerb: verb !== null }, 'monitor: tab activity');
      publishTabChange(updated, tab.project_id, machine);
      return { ok: true, tab: updated };
    }
  }
  return { ok: true, tab: await applyState(repos, log, tab, input.tool, interpreted) };
}

/** Records the event for the tab, updates its state and publishes the change. */
export async function applyState(repos: Repositories, log: FastifyBaseLogger, tab: Tab, tool: string, next: Interpreted): Promise<Tab> {
  const { tab: updated } = await repos.tabs.recordEvent(tab.id, {
    kind: next.kind,
    tool,
    text: next.text,
    meta: next.meta,
    activity: next.activity,
    activityVerb: next.verb,
    ...(next.continuesWait ? { continuesWait: true } : {}),
  });
  const machine = await repos.machines.findById(tab.machine_id);
  log.info({ tabId: tab.id, machineId: machine?.id, tool, kind: next.kind, textLen: next.text?.length ?? 0 }, 'monitor: tab state');
  publishTabChange(updated, tab.project_id, machine);
  return updated;
}

/** Tells the monitor subscribers (WS handler) about a tab whose state or seen-ness changed. */
export function publishTabChange(tab: Tab, projectId: string, machine: { id: string; owner_id: string | null } | undefined): void {
  monitorBus.publish({ tab, project_id: projectId, machine_id: machine?.id ?? '', owner_id: machine?.owner_id ?? null });
}
