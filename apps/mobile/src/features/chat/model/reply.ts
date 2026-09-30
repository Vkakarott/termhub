import { replyExcerpt } from '@/services/api/contract';
import type { ChatMessage } from './types';

/** The message the next send answers, while it is being written and on the optimistic row (TER-447). */
export type ReplyRef = { id: string; role: 'user' | 'assistant'; excerpt: string };

export const REPLY_AUTHOR: Record<ReplyRef['role'], string> = { assistant: 'Concierge', user: 'Você' };

/** A row the person can answer: the server has it (not a local row) and it has words or files. An
 * answer still being written has neither, and the server would refuse it. */
export const isReplyable = (m: ChatMessage): boolean => m.local === undefined && (m.text.length > 0 || (m.attachments?.length ?? 0) > 0);

/** The reference a reply to `m` carries, its excerpt cut the way the server cuts the snapshot. */
export const replyRefOf = (m: ChatMessage): ReplyRef => ({ id: m.id, role: m.role, excerpt: replyExcerpt(m.text, (m.attachments ?? []).map((a) => a.name)) });
