import type { TabActivity } from '../db/repositories/types.js';

/**
 * Claude Code tool name → what the person on the floor is doing. Exact names: a tool Claude Code
 * adds tomorrow reads `working` until it is classified here, never something wrong. Only the
 * name is ever looked at — the tool's input never reaches the server for this event.
 */
const BY_TOOL: Record<string, TabActivity> = {
  Edit: 'coding', Write: 'coding', MultiEdit: 'coding', NotebookEdit: 'coding',
  Read: 'reading', Grep: 'reading', Glob: 'reading', LS: 'reading',
  WebSearch: 'researching', WebFetch: 'researching',
  EnterPlanMode: 'planning', ExitPlanMode: 'planning', AskUserQuestion: 'planning', TodoWrite: 'planning', TaskCreate: 'planning', TaskUpdate: 'planning',
  Bash: 'terminal',
};

export function activityOf(toolName: unknown): TabActivity {
  return typeof toolName === 'string' ? (BY_TOOL[toolName] ?? 'working') : 'working';
}
