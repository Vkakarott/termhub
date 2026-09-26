import type { Repositories } from '../db/repositories/index.js';
import { getProvider, type IntegrationProvider } from '../integrations/index.js';
import { ticketLinkJson } from '../integrations/ticket-link.js';
import { sourceIdentity, type TicketSource } from './schema.js';

export interface SourceSyncResult {
  provider: IntegrationProvider;
  integration_id: string;
  scope: string;
  fetched?: number;
  created?: number;
  updated?: number;
  removed?: number;
  truncated?: boolean;
  error?: string;
}

export interface SyncResult {
  sources: SourceSyncResult[];
  synced_at: string;
}

/** Last full sync per project (in memory; one active container). Feeds the tool throttle and `last_sync`. */
const lastByProject = new Map<string, SyncResult>();
export const lastSync = (projectId: string): SyncResult | null => lastByProject.get(projectId) ?? null;
/** Drops the project's last sync (setup saved: its sources may have changed), so the next sync is not throttled. */
export const forgetSync = (projectId: string): void => void lastByProject.delete(projectId);

/** A scheduled run of one source: replaces that source's entry in the project's last sync (or starts one). */
function recordSource(projectId: string, r: SourceSyncResult): void {
  const prev = lastByProject.get(projectId)?.sources ?? [];
  const id = sourceIdentity(r);
  const i = prev.findIndex((s) => sourceIdentity(s) === id);
  const sources = i >= 0 ? prev.map((s, j) => (j === i ? r : s)) : [...prev, r];
  lastByProject.set(projectId, { sources, synced_at: new Date().toISOString() });
}

/**
 * Fetches one source into the staging table. Imported cards only get their ticket link refreshed —
 * column and title stay. Never throws for a provider failure: it comes back as `error`.
 */
export async function syncSource(repos: Repositories, projectId: string, source: TicketSource, legacyNullScope: boolean): Promise<SourceSyncResult> {
  const base = { provider: source.provider, integration_id: source.integration_id, scope: source.scope };
  const integration = await repos.integrations.findById(source.integration_id);
  const secret = await repos.integrations.getSecret(source.integration_id);
  if (!integration || !secret) return { ...base, error: 'Integração de tickets não encontrada' };
  if (integration.provider !== source.provider) return { ...base, error: 'Provedor da fonte não bate com a integração' };

  let page;
  try {
    page = await getProvider(source.provider).listTickets(secret, integration.config, source);
  } catch (e) {
    return { ...base, error: `Falha ao consultar ${source.provider}: ${(e as Error).message}` };
  }
  const where = { integration_id: source.integration_id, scope: source.scope };
  try {
    const r = await repos.tickets.upsertMany(
      projectId,
      page.tickets.map((t) => ({
        ...where,
        provider: t.provider,
        sync_key: t.sync_key,
        key: t.key,
        title: t.title,
        description: t.description,
        url: t.url,
        state: t.state,
        status: t.status,
        meta: { ...(t.meta ?? {}), updated_at: t.updatedAt, scope: source.scope },
      })),
    );
    for (const linked of r.linked) {
      const t = page.tickets.find((x) => x.sync_key === linked.sync_key);
      if (t && linked.task_id) await repos.tasks.setExternalRef(linked.task_id, ticketLinkJson({ ...t, updated_at: t.updatedAt }, where));
    }
    // tickets that left the source (filter, closed) and were never imported leave the list
    const removed = await repos.tickets.pruneMissing(projectId, where, page.tickets.map((t) => t.sync_key), legacyNullScope);
    return { ...base, fetched: page.tickets.length, created: r.created, updated: r.updated, removed, truncated: page.truncated };
  } catch (e) {
    return { ...base, error: `Falha ao gravar os tickets: ${(e as Error).message}` };
  }
}

/** Every source of the project, one after the other; one failing source does not stop the rest. */
export async function syncProjectTickets(repos: Repositories, projectId: string, sources: TicketSource[]): Promise<SyncResult> {
  const perIntegration = new Map<string, number>();
  for (const s of sources) perIntegration.set(s.integration_id, (perIntegration.get(s.integration_id) ?? 0) + 1);
  const results: SourceSyncResult[] = [];
  for (const s of sources) results.push(await syncSource(repos, projectId, s, perIntegration.get(s.integration_id) === 1));
  const result = { sources: results, synced_at: new Date().toISOString() };
  lastByProject.set(projectId, result);
  return result;
}

/** Periodic sync: each source on its own sync_minutes. */
export function startTicketSyncScheduler(repos: Repositories, log: { info: (o: object, m: string) => void; warn: (o: object, m: string) => void }) {
  const lastRun = new Map<string, number>();
  const tick = async () => {
    const items = await repos.projectSetup.listWithAutoSync().catch(() => []);
    for (const item of items) {
      const all = (await repos.projectSetup.get(item.project_id)).data.ticket_sources;
      for (const source of item.sources) {
        const runKey = `${item.project_id}\u0000${sourceIdentity(source)}`;
        if (Date.now() - (lastRun.get(runKey) ?? 0) < source.sync_minutes * 60_000) continue;
        lastRun.set(runKey, Date.now());
        const onIntegration = all.filter((s) => s.integration_id === source.integration_id).length;
        const r = await syncSource(repos, item.project_id, source, onIntegration === 1);
        recordSource(item.project_id, r);
        const { error, ...counts } = r;
        if (error) log.warn({ projectId: item.project_id, provider: r.provider, scope: r.scope, err: error }, 'falha no sync de tickets');
        else log.info({ projectId: item.project_id, ...counts }, 'tickets sincronizados');
      }
    }
  };
  const timer = setInterval(() => void tick(), 60_000);
  setTimeout(() => void tick(), 5_000);
  return () => clearInterval(timer);
}
