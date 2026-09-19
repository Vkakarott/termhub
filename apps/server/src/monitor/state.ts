import type { Tab, TabState } from '../db/repositories/types.js';

/** Tools whose hooks we understand (the hook script names itself). */
export const HOOK_TOOLS = ['claude', 'codex'] as const;
export type HookTool = (typeof HOOK_TOOLS)[number];

/** The tool's own message (question, permission prompt, last answer) is kept, capped; nothing else. */
export const STATE_TEXT_MAX = 2000;

export interface Interpreted {
  kind: TabState;
  text: string | null;
  meta: Record<string, unknown>;
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);
const cap = (v: string | null): string | null => (v && v.length > STATE_TEXT_MAX ? `${v.slice(0, STATE_TEXT_MAX - 1)}…` : v);

/** Claude Code hook payloads (stdin JSON): https://docs.claude.com/en/docs/claude-code/hooks */
function interpretClaude(ev: Record<string, unknown>): Interpreted | null {
  const name = str(ev.hook_event_name);
  switch (name) {
    case 'SessionStart':
    case 'UserPromptSubmit':
    case 'PreCompact':
    case 'PreToolUse':
      // the prompt / tool input is the user's or the tool's content: only the fact that it is busy is kept
      return { kind: 'working', text: null, meta: { event: name } };
    case 'Notification': {
      const type = str(ev.notification_type);
      const message = cap(str(ev.message));
      if (type === 'permission_prompt') return { kind: 'waiting_permission', text: message, meta: { event: name, type } };
      if (type === 'idle_prompt' || type === 'elicitation_dialog') return { kind: 'waiting_input', text: message, meta: { event: name, type } };
      return null; // auth_success and friends: nothing the user has to act on
    }
    case 'Stop':
      // A finished turn is the tool waiting for the person (same as Codex); the idle_prompt
      // notification only comes about a minute later. The last answer, when sent, is the question.
      return { kind: 'waiting_input', text: cap(str(ev.last_assistant_message)), meta: { event: name } };
    case 'SessionEnd':
      return { kind: 'idle', text: null, meta: { event: name, reason: str(ev.reason) } };
    default:
      return null;
  }
}

/**
 * Codex CLI `notify` payload (argv JSON): `{ type: "agent-turn-complete", "last-assistant-message": ... }`.
 * Codex has no idle/permission notification, so a finished turn is its "needs you" signal:
 * the last assistant message is the question the person has to answer.
 */
function interpretCodex(ev: Record<string, unknown>): Interpreted | null {
  const type = str(ev.type);
  if (type === 'agent-turn-complete') {
    return { kind: 'waiting_input', text: cap(str(ev['last-assistant-message'])), meta: { event: type } };
  }
  return null;
}

/**
 * Maps a raw hook payload to a tab state, or null when the event carries nothing worth showing.
 * Pure: the route validates the token and the tab; this only reads the payload.
 */
export function interpretHookEvent(tool: HookTool, raw: unknown): Interpreted | null {
  if (!isObj(raw)) return null;
  return tool === 'claude' ? interpretClaude(raw) : interpretCodex(raw);
}

/** States in which the tool is waiting for the person (the "needs you" list). */
export const NEEDS_YOU: readonly TabState[] = ['waiting_input', 'waiting_permission'];

/**
 * A tab "needs you" when it is waiting and has not been seen since that state began: a new hook
 * event bumps `state_at`, so an already-seen tab needs you again automatically.
 */
export function needsYou(tab: Pick<Tab, 'state' | 'state_at' | 'state_seen_at'>): boolean {
  if (!tab.state || !NEEDS_YOU.includes(tab.state) || !tab.state_at) return false;
  return !tab.state_seen_at || tab.state_seen_at < tab.state_at;
}
