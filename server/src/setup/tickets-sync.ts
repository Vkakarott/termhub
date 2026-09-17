import type { Repositories } from '../db/repositories/index.js';
import { getProvider, type TicketSourceConfig } from '../integrations/index.js';
import { HttpError } from '../lib/errors.js';

export interface SyncResult {
  fetched: number;
  created: number;
  updated: number;
  synced_at: string;
}

/** Busca os tickets na fonte configurada e faz upsert no kanban do projeto. */
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

  const r = await repos.tasks.upsertExternal(
    projectId,
    tickets.map((t) => ({
      key: t.key,
      title: `${t.identifier} ${t.title}`.trim(),
      description: t.description,
      status: t.status,
      ref: { provider: t.provider, id: t.id, identifier: t.identifier, url: t.url, state: t.state, status: t.status, updated_at: t.updatedAt, ...(t.meta ?? {}) },
    })),
  );
  return { fetched: tickets.length, ...r, synced_at: new Date().toISOString() };
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
