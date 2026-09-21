/** What the chat cares about in one `stream-json` line. Everything else is ignored on purpose:
 * the CLI's frame set grows, and an unknown frame must never break a conversation. */
export type ChatFrame =
  | { type: 'text'; delta: string }
  | { type: 'action'; tool: string; tool_use_id: string; args: unknown }
  | { type: 'action_result'; tool_use_id: string; ok: boolean }
  | { type: 'done'; session_id?: string; usage?: unknown }
  | { type: 'error'; message: string };

/** `mcp__termhub__list_tabs` -> `list_tabs`; anything else is kept as it came. */
const toolName = (raw: string) => (raw.startsWith('mcp__termhub__') ? raw.slice('mcp__termhub__'.length) : raw);

export function parseFrame(line: string): ChatFrame | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
  const f = parsed as Record<string, unknown>;
  const type = f.type;

  if (type === 'stream_event') {
    const event = f.event as { type?: string; delta?: { type?: string; text?: string } } | undefined;
    if (event?.type === 'content_block_delta' && event.delta?.type === 'text_delta' && event.delta.text) return { type: 'text', delta: event.delta.text };
    return null;
  }
  if (type === 'assistant') {
    const content = (f.message as { content?: unknown[] } | undefined)?.content ?? [];
    for (const block of content as { type?: string; id?: string; name?: string; input?: unknown }[]) {
      if (block.type === 'tool_use' && block.id && block.name) return { type: 'action', tool: toolName(block.name), tool_use_id: block.id, args: block.input ?? {} };
    }
    return null;
  }
  if (type === 'user') {
    const content = (f.message as { content?: unknown[] } | undefined)?.content ?? [];
    for (const block of content as { type?: string; tool_use_id?: string; is_error?: boolean }[]) {
      if (block.type === 'tool_result' && block.tool_use_id) return { type: 'action_result', tool_use_id: block.tool_use_id, ok: block.is_error !== true };
    }
    return null;
  }
  if (type === 'result') return { type: 'done', session_id: typeof f.session_id === 'string' ? f.session_id : undefined, usage: f.usage };
  if (type === 'termhub_error') return { type: 'error', message: String(f.message ?? 'runner failed') };
  return null;
}
