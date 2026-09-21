import { config } from '../config.js';
import { HttpError } from '../lib/errors.js';
import type { RunnerClient, RunnerInput } from './service.js';

/** Talks to the concierge container over the compose network. Never logs the body: it carries the
 * user's message and a live token. */
export function httpRunner(): RunnerClient {
  return {
    run: (input: RunnerInput) => {
      const settings = config.concierge;
      if (!settings) throw new HttpError(503, 'O chat não está configurado neste servidor', 'CONCIERGE_DISABLED');
      return (async function* () {
        const res = await fetch(`${settings.url}/run`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-concierge-secret': settings.secret },
          body: JSON.stringify({ ...input, mcp_url: settings.mcpUrl }),
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
