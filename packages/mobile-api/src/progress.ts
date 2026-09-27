import { z } from 'zod';

/** Progress panel read model (spec 2026-09-26 progress-panel §4.4), shared by /api/progress and /api/m/v1/progress. */
export const progressScope = z.enum(['active', 'all']);
export const progressTabState = z.enum(['working', 'waiting_input', 'waiting_permission', 'idle', 'error']);
const taskStatus = z.enum(['backlog', 'todo', 'doing', 'done']);
const count = z.number().int().nonnegative();
const percent = z.number().int().min(0).max(100);

export const progressEstimate = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('done') }),
  z.object({ kind: z.literal('none'), reason: z.enum(['not_started', 'few_samples']) }),
  z.object({ kind: z.literal('range'), low_s: count, high_s: count, basis: z.enum(['agent_time', 'wall_clock']), samples: z.number().int().positive() }),
]);

export const agentOnCard = z.object({
  tab_id: z.string(),
  tab_name: z.string(),
  machine_name: z.string(),
  /** the subtask this tab was started on; null = the card itself */
  subtask_ref: z.string().nullable(),
  state: progressTabState.nullable(),
  state_at: z.string().nullable(),
  needs_you: z.boolean(),
  activity: z.string().nullable(),
  activity_verb: z.string().nullable(),
  rate_limited: z.boolean(),
});

export const cardProgress = z.object({
  id: z.string(),
  ref: z.string(),
  title: z.string(),
  type: z.string(),
  status: taskStatus,
  column_name: z.string().nullable(),
  units: z.object({ done: count, total: count }),
  percent,
  started_at: z.string().nullable(),
  done_at: z.string().nullable(),
  active_seconds: count,
  estimate: progressEstimate,
  /** null = the caller cannot read terminals */
  agents: z.array(agentOnCard).nullable(),
});

export const epicProgress = z.object({
  id: z.string(),
  ref: z.string(),
  title: z.string(),
  project: z.object({ id: z.string(), key: z.string(), name: z.string() }),
  units: z.object({ done: count, total: count, backlog_total: count }),
  percent,
  estimate: progressEstimate,
  cards_without_estimate: count,
  agents: z.object({ working: count, needs_you: count, idle: count }).nullable(),
  cards: z.array(cardProgress),
});

export const progressResponse = z.object({ epics: z.array(epicProgress), generated_at: z.string() });

export type ProgressScope = z.infer<typeof progressScope>;
export type ProgressEstimate = z.infer<typeof progressEstimate>;
export type AgentOnCard = z.infer<typeof agentOnCard>;
export type CardProgress = z.infer<typeof cardProgress>;
export type EpicProgress = z.infer<typeof epicProgress>;
export type ProgressResponse = z.infer<typeof progressResponse>;
