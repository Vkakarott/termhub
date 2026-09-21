import { createServer } from 'node:http';
import { z } from 'zod';
import { RunFailed, runClaude } from './run.js';

const SECRET = process.env.CONCIERGE_SECRET ?? '';
const PORT = Number(process.env.PORT ?? 4100);

const body = z.object({
  session_id: z.string().uuid(),
  resume: z.boolean(),
  text: z.string().min(1).max(8000),
  config_dir: z.string().min(1),
  model: z.string().max(60).nullish(),
  token: z.string().min(1),
  mcp_url: z.string().url(),
});

const server = createServer(async (req, res) => {
  if (req.method === 'GET' && req.url === '/health') return res.writeHead(200).end('ok');
  if (req.method !== 'POST' || req.url !== '/run') return res.writeHead(404).end();
  // The compose network is not authentication: the shared secret is (spec §7.2).
  if (!SECRET || req.headers['x-concierge-secret'] !== SECRET) return res.writeHead(401).end();

  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const parsed = body.safeParse(JSON.parse(Buffer.concat(chunks).toString() || '{}'));
  if (!parsed.success) return res.writeHead(400, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'invalid body' }));

  res.writeHead(200, { 'content-type': 'application/x-ndjson', 'cache-control': 'no-store' });
  try {
    for await (const line of runClaude(parsed.data)) res.write(line + '\n');
    res.end();
  } catch (e) {
    // The frames already sent stay valid; the last line says why it stopped. Never log the body.
    const code = e instanceof RunFailed ? e.code : null;
    res.write(JSON.stringify({ type: 'termhub_error', code, message: e instanceof Error ? e.message : 'unknown' }) + '\n');
    res.end();
  }
});

server.listen(PORT, () => console.log(`concierge listening on ${PORT}`));
