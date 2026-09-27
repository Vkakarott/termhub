/**
 * What the project chat dock remembers per project (spec 2026-09-26 project chat dock §4.1): whether
 * it is open, how wide it is and whether it fills the project window. One `localStorage` key for all
 * projects, like the pane layout (`lib/layout.ts`), since it is a per-screen preference.
 */
export interface ChatPref {
  open: boolean;
  width: number;
  maximized: boolean;
}
export type ChatPrefs = Record<string, ChatPref>;

export const CHAT_PREFS_KEY = 'termhub:project-chat';
/** The smallest width at which the chat composer (TER-98) still fits its buttons. */
export const CHAT_MIN_WIDTH = 320;
export const CHAT_MAX_WIDTH = 720;
/** The old drawer's width. */
export const CHAT_DEFAULT_WIDTH = 420;
export const DEFAULT_CHAT_PREF: ChatPref = { open: false, width: CHAT_DEFAULT_WIDTH, maximized: false };

export function clampChatWidth(w: unknown): number {
  if (typeof w !== 'number' || !Number.isFinite(w)) return CHAT_DEFAULT_WIDTH;
  return Math.min(CHAT_MAX_WIDTH, Math.max(CHAT_MIN_WIDTH, Math.floor(w)));
}

function sanitizePref(raw: unknown): ChatPref | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  return { open: r.open === true, width: clampChatWidth(r.width), maximized: r.maximized === true };
}

export function loadChatPrefs(storage: Storage = localStorage): ChatPrefs {
  let raw: unknown;
  try {
    const text = storage.getItem(CHAT_PREFS_KEY);
    raw = text ? JSON.parse(text) : undefined;
  } catch {
    return {};
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out: ChatPrefs = {};
  for (const [id, value] of Object.entries(raw as Record<string, unknown>)) {
    const pref = sanitizePref(value);
    if (pref) out[id] = pref;
  }
  return out;
}

export function saveChatPrefs(prefs: ChatPrefs, storage: Storage = localStorage): void {
  try {
    storage.setItem(CHAT_PREFS_KEY, JSON.stringify(prefs));
  } catch {
    /* storage full or blocked: the preference lives in memory for this session */
  }
}

export const prefOf = (prefs: ChatPrefs, id: string): ChatPref => prefs[id] ?? DEFAULT_CHAT_PREF;

export function withPref(prefs: ChatPrefs, id: string, patch: Partial<ChatPref>): ChatPrefs {
  const next = { ...prefOf(prefs, id), ...patch };
  return { ...prefs, [id]: { ...next, width: clampChatWidth(next.width) } };
}
