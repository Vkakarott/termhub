import { createServer, type Server } from 'node:http';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';

/** The real config reads the process env and exits on a bad one; these tests need to flip the
 * concierge settings per case, so they drive a stand-in object the runner reads on every call. */
const state = vi.hoisted(() => ({
  config: {} as { concierge?: { url: string; secret: string; mcpUrl: string } },
}));
vi.mock('../config.js', () => ({ config: state.config }));

const { httpRunner } = await import('./runner.js');

const input = {
  session_id: '3f1e9b1e-0000-4000-8000-000000000001',
  resume: false,
  text: 'o que está rodando?',
  config_dir: '/accounts/primary',
  model: null,
  token: 'thb_pat_' + 'A'.repeat(43),
};

/** Serves /run: streams `lines`, then either ends or hangs with the socket still open. */
let bodies: string[] = [];
let mode: { lines: string[]; hang: boolean; status: number } = { lines: [], hang: false, status: 200 };
let server: Server;
let port = 0;

beforeAll(async () => {
  server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += String(c)));
    req.on('end', () => {
      bodies.push(raw);
      res.writeHead(mode.status, { 'content-type': 'application/x-ndjson' });
      for (const line of mode.lines) res.write(line + '\n');
      if (!mode.hang) res.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as { port: number }).port;
});

afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

function configure(over: Partial<{ url: string; secret: string; mcpUrl: string }> = {}) {
  state.config.concierge = { url: `http://127.0.0.1:${port}`, secret: 's3cret', mcpUrl: 'https://termhub.dev/mcp', ...over };
}

it('refuses with 503 CONCIERGE_DISABLED when the chat is not configured', async () => {
  state.config.concierge = undefined;
  // MCP_URL unset (or the secret, or the URL) counts as not configured: there would be no endpoint
  // outside Cloudflare Access to reach the machines through.
  expect(() => httpRunner().run(input)).toThrowError(expect.objectContaining({ statusCode: 503, code: 'CONCIERGE_DISABLED' }));
});

it('sends the configured MCP url, never one derived from PUBLIC_URL', async () => {
  configure();
  bodies = [];
  mode = { lines: [JSON.stringify({ type: 'result' })], hang: false, status: 200 };
  const lines: string[] = [];
  for await (const line of httpRunner().run(input)) lines.push(line);

  expect(lines).toHaveLength(1);
  expect(JSON.parse(bodies[0]).mcp_url).toBe('https://termhub.dev/mcp');
});

it('fails with 502 CONCIERGE_FAILED when the container refuses the request', async () => {
  configure();
  mode = { lines: [], hang: false, status: 500 };
  const iterate = async () => {
    for await (const _line of httpRunner().run(input)) void _line;
  };
  await expect(iterate()).rejects.toMatchObject({ statusCode: 502, code: 'CONCIERGE_FAILED' });
});
