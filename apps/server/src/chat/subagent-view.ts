import type { ChatSubagent } from '../db/repositories/chat-subagents.js';
import type { SubagentStatus } from './stream.js';

export type { SubagentStatus } from './stream.js';

/** How long a subagent stays in the panel after it ends (spec 2026-09-26 §4): "há N min" / "levou N
 * min" only makes sense for something the person could plausibly still be looking at. */
export const PANEL_RECENT_MS = 10 * 60 * 1000;

/** The most rows the panel ever shows at once. */
export const PANEL_MAX = 20;

/** What the panel and the card need about one subagent — never its prompt or its turns' text
 * (spec 2026-09-26 §7). */
export interface SubagentView {
  id: string;
  description: string;
  subagent_type: string | null;
  status: SubagentStatus;
  started_at: string;
  ended_at: string | null;
}

export const toSubagentView = (s: ChatSubagent): SubagentView => ({
  id: s.id,
  description: s.description,
  subagent_type: s.subagent_type,
  status: s.status,
  started_at: s.started_at,
  ended_at: s.ended_at,
});
