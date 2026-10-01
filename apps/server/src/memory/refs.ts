import type { MemoryKind } from '../db/repositories/memory-items.js';

/** A `search_memory` result's kind: a remembered decision, or one of `memory_items`' own kinds. */
export type MemoryRefKind = 'decision' | MemoryKind;

/** `<kind>:<id>` — what `search_memory` hands back and `record_decision`/`answer_tab_question` take
 *  as a `sources` entry. The id half is a `newId()` (lowercase base36), never longer than 64 chars. */
export const MEMORY_REF = /^(decision|task|message|action|doc|note|lesson|project_note):[a-z0-9]{1,64}$/;

export function parseRef(ref: string): { kind: MemoryRefKind; id: string } | null {
  const m = MEMORY_REF.exec(ref);
  if (!m) return null;
  return { kind: m[1] as MemoryRefKind, id: ref.slice(m[1].length + 1) };
}
