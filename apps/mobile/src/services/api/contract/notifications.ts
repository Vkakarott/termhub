// Copied verbatim from packages/mobile-api/src/notifications.ts @ c6bab0a (feat/mobile-chat-server).
// Replaced by `import … from '@termhub/mobile-api' once that package is on main. Do not edit here.
import { z } from 'zod';

export const notificationRow = z.object({
  id: z.string(),
  kind: z.enum(['confirmation', 'reply', 'device_request']),
  title: z.string(),
  body: z.string(),
  data: z.record(z.unknown()),
  created_at: z.string(),
  read_at: z.string().nullable(),
});
export const notificationsResponse = z.object({ notifications: z.array(notificationRow), unread: z.number().int(), next_before: z.string().nullable() });
