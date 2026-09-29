/** The part of a stored message this needs. */
export interface ThreadRow {
  id: string;
  role: string;
  text: string;
  error_code: string | null;
}

/**
 * The ids of `open` that `messages` lists as an assistant row with no text and no error, in the order
 * of `messages`. What `GET /api/chat` answers as `open_answer_ids`: the rows a screen shows as being
 * answered. The two lists are read at different moments; a row that ended in between has text or an
 * error by now, and an id the thread no longer has is left out.
 */
export function openAnswersIn(messages: readonly ThreadRow[], open: readonly string[]): string[] {
  const ids = new Set(open);
  return messages.filter((m) => m.role === 'assistant' && m.text === '' && m.error_code === null && ids.has(m.id)).map((m) => m.id);
}
