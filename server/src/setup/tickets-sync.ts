import type { Repositories } from '../db/repositories/index.js';
import { getProvider, type TicketSourceConfig } from '../integrations/index.js';
import { HttpError } from '../lib/errors.js';

export interface SyncResult {
  fetched: number;
  created: number;
  updated: number;
  removed: number;
  synced_at: string;
}

/** id usado pela API do provedor, a partir da chave estável. */
export function externalId(key: string, provider: string): string {
  if (provider === 'github') return key.split('#').pop() ?? key;
  return key.slice(key.indexOf(':') + 1);
}

export function ticketRef(t: { provider: string; id: string; identifier: string; url: string; state: string; status: string; updatedAt: string; meta?: Record<string, unknown> }, scope: string) {
  return { provider: t.provider, id: t.id, identifier: t.identifier, url: t.url, state: t.state, status: t.status, scope, updated_at: t.updatedAt, ...(t.meta ?? {}) };
}

/**
 * Busca os tickets na fonte e atualiza o staging (tabela tickets). Tasks já importadas
 * só recebem o espelho do estado externo (external_ref) — coluna/título ficam como estão.
 */
export async function syncProjectTickets(repos: Repositories, projectId: string, source: TicketSourceConfig): Promise<SyncResult> {
  const integration = await repos.integrations.findById(source.integration_id);
  const secret = await repos.integrations.getSecret(source.integration_id);
  if (!integration || !secret) throw new HttpError(400, 'Integração de tickets não encontrada', 'BAD_REQUEST');
  if (integration.provider !== source.provider) throw new HttpError(400, 'Provedor do setup não bate com a integração', 'BAD_REQUEST');

  let tickets;
  try {
    tickets = await getProvider(source.provider).listTickets(secret, integration.config, source);
  } catch (e) {
    throw new HttpError(502, `Falha ao consultar ${source.provider}: ${(e as Error).message}`, 'PROVIDER_ERROR');
  }

  const r = await repos.tickets.upsertMany(
    projectId,
    tickets.map((t) => ({
      integration_id: source.integration_id,
      provider: t.provider,
      external_key: t.key,
      identifier: t.identifier,
      title: t.title,
      description: t.description,
      url: t.url,
      state: t.state,
      status: t.status,
      meta: { ...(t.meta ?? {}), updated_at: t.updatedAt, scope: source.scope },
    })),
  );
  for (const linked of r.linked) {
    const src = tickets.find((t) => t.key === linked.external_key);
    if (src && linked.task_id) await repos.tasks.setExternalRef(linked.task_id, ticketRef(src, source.scope));
  }
  // tickets que saíram do filtro/escopo e nunca foram importados somem da lista
  const removed = await repos.tickets.pruneMissing(projectId, source.integration_id, tickets.map((t) => t.key));
  return { fetched: tickets.length, created: r.created, updated: r.updated, removed, synced_at: new Date().toISOString() };
}

/** Sync periódico dos projetos com sync_minutes > 0. */
export function startTicketSyncScheduler(repos: Repositories, log: { info: (o: object, m: string) => void; warn: (o: object, m: string) => void }) {
  const lastRun = new Map<string, number>();
  const tick = async () => {
    const items = await repos.projectSetup.listWithAutoSync().catch(() => []);
    for (const item of items) {
      const every = item.data.tickets!.sync_minutes * 60_000;
      const last = lastRun.get(item.project_id) ?? 0;
      if (Date.now() - last < every) continue;
      lastRun.set(item.project_id, Date.now());
      try {
        const r = await syncProjectTickets(repos, item.project_id, item.data.tickets!);
        log.info({ projectId: item.project_id, ...r }, 'tickets sincronizados');
      } catch (e) {
        log.warn({ projectId: item.project_id, err: (e as Error).message }, 'falha no sync de tickets');
      }
    }
  };
  const timer = setInterval(() => void tick(), 60_000);
  setTimeout(() => void tick(), 5_000);
  return () => clearInterval(timer);
}
