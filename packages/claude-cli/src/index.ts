/** Everything a runner needs to spawn `claude -p` the one way the permission gate allows: the
 * exact argv and the MCP config it points at. Two runners (the server's container today, the
 * user's own machine tomorrow) build the same command line from here, so neither can drift from
 * the other. No spawning, no file I/O, no process handling — that stays with each runner.
 *
 * `ClaudeRunSpec` has no prompt field: the prompt never becomes an argument here, so a prompt
 * beginning with "-" can never be read as a flag. Each runner writes it to the child's stdin
 * instead, and that guarantee is exercised end to end where the runner exists — the concierge's
 * fake-CLI test in apps/concierge/src/run.test.ts, and the agent's equivalent once Task 3 adds it. */

export interface ClaudeRunSpec {
  session_id: string;
  resume: boolean;
  mcp_config_path: string;
  model?: string | null;
}

/** Tools the concierge must never have: with any of them it could reach a machine outside the MCP,
 * where the permission gate lives (spec §4.1). */
export const DISALLOWED_TOOLS = 'Bash,Read,Write,Edit,WebFetch,WebSearch';

/** Every flag the concierge must run with, in a fixed order. */
export function buildClaudeArgs(spec: ClaudeRunSpec): string[] {
  return [
    '-p',
    // Exactly one of the two, never both: the CLI answers "--session-id can only be used with
    // --continue or --resume if --fork-session is also specified" and exits 1 before doing any
    // work, which broke every message after the first. --session-id is how the server names a new
    // session; --resume is how it continues one it already named.
    ...(spec.resume ? ['--resume', spec.session_id] : ['--session-id', spec.session_id]),
    '--output-format', 'stream-json',
    // required by the CLI: with --print, --output-format=stream-json refuses to run without it
    // ("Error: When using --print, --output-format=stream-json requires --verbose"). It only
    // changes what the CLI writes to stdout, never logging the prompt.
    '--verbose',
    '--include-partial-messages',
    '--mcp-config', spec.mcp_config_path,
    '--strict-mcp-config',
    '--allowed-tools', 'mcp__termhub__*',
    '--disallowed-tools', DISALLOWED_TOOLS,
    ...(spec.model ? ['--model', spec.model] : []),
  ];
}

/** The MCP config file's contents, so both runners write the same shape: one HTTP server, the
 * token in the header. */
export function mcpConfig(url: string, token: string): string {
  return JSON.stringify({ mcpServers: { termhub: { type: 'http', url, headers: { Authorization: `Bearer ${token}` } } } });
}
