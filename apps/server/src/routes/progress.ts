import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { progressResponse, progressScope } from '@termhub/mobile-api';
import type { Repositories } from '../db/repositories/index.js';
import { canAccess } from '../auth/permissions.js';
import { scoped } from '../auth/scope.js';
import { aggregateEpic, selectEpics } from '../progress/aggregate.js';

const query = z.object({ project_id: z.string().min(1).max(64).optional(), scope: progressScope.default('active') });

/**
 * The progress panel (spec 2026-09-26 progress-panel §4.5), mounted at /api/progress and, for the
 * phone, /api/m/v1/progress. Guarded as `tasks`; agents (tab names and states) only with terminals:read.
 */
export async function progressRoutes(app: FastifyInstance, repos: Repositories, deps: { now?: () => Date } = {}) {
  app.get('/', async (request) => {
    const q = query.parse(request.query ?? {});
    if (q.project_id) await scoped(repos, request).project(q.project_id);
    const includeAgents = await canAccess(repos, request.user, 'terminals', 'read');
    const rows = await repos.progress.list({ owner: request.scope.ownerId, projectId: q.project_id ?? null });
    const epics = selectEpics(rows.map((e) => aggregateEpic(e, includeAgents)), q.scope);
    return progressResponse.parse({ epics, generated_at: (deps.now?.() ?? new Date()).toISOString() });
  });
}
