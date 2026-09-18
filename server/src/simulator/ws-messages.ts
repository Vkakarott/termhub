import { z } from 'zod';

const coord = z.number().finite().min(-10_000).max(10_000);

export const clientMessageSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('tap'), x: coord, y: coord }),
  z.object({ type: z.literal('drag'), points: z.array(z.object({ x: coord, y: coord, t: z.number().finite() })).min(1).max(500) }),
  z.object({ type: z.literal('keys'), text: z.string().min(1).max(2000) }),
  z.object({ type: z.literal('key'), name: z.string().min(1).max(32) }),
  z.object({ type: z.literal('button'), name: z.enum(['home', 'lock', 'volumeUp', 'volumeDown']) }),
  z.object({ type: z.literal('rotate'), orientation: z.enum(['portrait', 'landscape']) }),
  z.object({ type: z.literal('settings'), scale: z.number().int().min(10).max(100), quality: z.number().int().min(1).max(100) }),
  z.object({ type: z.literal('pause') }),
  z.object({ type: z.literal('resume') }),
  z.object({ type: z.literal('ping') }),
]);

export type ClientMessage = z.infer<typeof clientMessageSchema>;
