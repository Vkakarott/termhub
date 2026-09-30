import { z } from 'zod';

/**
 * The project's AI accounts and default models (TER-589): `GET/PUT /api/m/v1/projects/:id/setup/ai`,
 * the same bodies as the web's `/api/projects/:id/setup/ai`. `accounts` are ids in priority order.
 * Kept loose on read (`z.string()` models) so a server that learns a new model format never breaks the app;
 * the server validates what it saves.
 */
export const projectAiSchema = z.object({
  accounts: z.array(z.string()),
  models: z.object({ claude: z.string().nullable(), chatgpt: z.string().nullable() }),
});
export type ProjectAi = z.infer<typeof projectAiSchema>;

export const projectAiOption = z.object({
  id: z.string(),
  label: z.string(),
  provider: z.enum(['claude', 'chatgpt']),
  machine_id: z.string(),
  machine_name: z.string(),
  default: z.boolean(),
});
export type ProjectAiOption = z.infer<typeof projectAiOption>;

export const projectAiResponse = z.object({ ai: projectAiSchema, available: z.array(projectAiOption) });
export type ProjectAiResponse = z.infer<typeof projectAiResponse>;

export const projectAiBody = z.object({ ai: projectAiSchema });

/** Aliases every Claude CLI resolves itself; anything else is a full id an older CLI may not know. */
export const CLAUDE_MODEL_ALIASES = ['opus', 'sonnet', 'haiku'] as const;
