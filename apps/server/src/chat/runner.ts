import { config } from '../config.js';
import { HttpError } from '../lib/errors.js';
import type { RunnerClient, RunnerInput } from './service.js';

/**
 * Deadline for a whole run, one minute past the container's own 10-minute kill (see
 * `apps/concierge/src/run.ts`), so the container's cleaner path normally wins and this only fires
 * when the container itself is stuck — hung without closing the socket. Without it such a run holds
 * the per-conversation lock for ever and every later message answers 409 until the server restarts.
 */
const RUN_DEADLINE_MS = 11 * 60_000;

/** Talks to the concierge container over the compose network. Never logs the body: it carries the
 * user's message and a live token. */
export function httpRunner(opts: { deadlineMs?: number } = {}): RunnerClient {
  return {
    run: (input: RunnerInput) => {
      const settings = config.concierge;
      if (!settings) throw new HttpError(503, 'O chat não está configurado neste servidor', 'CONCIERGE_DISABLED');
      return (async function* () {
        // The signal covers the request *and* every read on its body, so a concierge that stops
        // sending without closing the connection is abandoned instead of waited on for ever. The
        // abort surfaces as a plain throw: the service keeps the text collected so far and marks the
        // answer as a failed run — not as a response status, the run did start.
        const res = await fetch(`${settings.url}/run`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-concierge-secret': settings.secret },
          body: JSON.stringify({ ...input, mcp_url: settings.mcpUrl }),
          signal: AbortSignal.timeout(opts.deadlineMs ?? RUN_DEADLINE_MS),
        });
        if (!res.ok || !res.body) throw new HttpError(502, 'O concierge não respondeu', 'CONCIERGE_FAILED');
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop() ?? '';
          for (const line of lines) if (line.trim()) yield line;
        }
        if (buffer.trim()) yield buffer;
      })();
    },
  };
}

/** The second runner: the same CLI, on a machine of the user's own, through its agent. Re-exported
 *  here so the two implementations of one interface are found in one place. */
export { agentRunner, type ClaudeChannelHost } from './agent-runner.js';
