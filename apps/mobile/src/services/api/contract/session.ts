// Copied verbatim from packages/mobile-api/src/session.ts @ c6bab0a (feat/mobile-chat-server).
// Replaced by `import … from '@termhub/mobile-api' once that package is on main. Do not edit here.
import { z } from 'zod';

export const challengeBody = z.object({
  device_id: z.string().min(1).max(64),
  purpose: z.enum(['refresh', 'decision']).default('refresh'),
  action_id: z.string().min(1).max(64).optional(),
});
export const challengeResponse = z.object({ challenge: z.string(), expires_at: z.string() });
export const tokenBody = z.object({ device_id: z.string().min(1).max(64), challenge: z.string().min(1).max(128), pin_proof: z.string().min(1).max(128) });
export const tokenResponse = z.object({ access_token: z.string(), expires_in: z.number().int() });
export const pushTokenBody = z.object({ token: z.string().regex(/^ExponentPushToken\[[A-Za-z0-9_-]+\]$/) });
