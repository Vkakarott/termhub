import { afterAll, beforeAll, expect, it } from 'vitest';

const PORT = 41917;
const SECRET = 'concierge-test-secret';

let server: { close(): void };

beforeAll(async () => {
  process.env.CONCIERGE_SECRET = SECRET;
  process.env.PORT = String(PORT);
  ({ server } = await import('./index.js'));
});

afterAll(() => server.close());

function post(path: string, requestBody: string) {
  return fetch(`http://127.0.0.1:${PORT}${path}`, {
    method: 'POST',
    body: requestBody,
    headers: { 'x-concierge-secret': SECRET },
  });
}

it('a malformed JSON body answers 400 and the process stays up', async () => {
  const res = await post('/run', '{');
  expect(res.status).toBe(400);

  // the actual regression: an unhandled JSON.parse throw used to take the whole service down
  const health = await fetch(`http://127.0.0.1:${PORT}/health`);
  expect(health.status).toBe(200);
});

it('a body over the size cap answers 413, before it is ever parsed', async () => {
  const oversized = 'x'.repeat(70 * 1024);
  const res = await post('/run', oversized);
  expect(res.status).toBe(413);
});
