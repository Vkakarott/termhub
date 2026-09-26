import { describe, expect, it, vi } from 'vitest';
import { EmbedError, httpEmbedder } from './embeddings.js';

const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });

describe('httpEmbedder', () => {
  it('posts the texts with the bearer secret and returns model + vectors', async () => {
    const fetchImpl = vi.fn(async () => ok({ model: 'm', dim: 2, vectors: [[1, 0], [0, 1]] }));
    const e = httpEmbedder('http://embed:8000', 's3', fetchImpl as unknown as typeof fetch);
    await expect(e.embed(['a', 'b'])).resolves.toEqual({ model: 'm', vectors: [[1, 0], [0, 1]] });
    const [url, init] = fetchImpl.mock.calls[0]! as unknown as [string, RequestInit];
    expect(url).toBe('http://embed:8000/embed');
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer s3');
    expect(JSON.parse(init.body as string)).toEqual({ texts: ['a', 'b'] });
  });
  it('an HTTP error, a malformed body or a count mismatch is an EmbedError', async () => {
    for (const res of [new Response('x', { status: 503 }), ok({ nope: 1 }), ok({ model: 'm', dim: 2, vectors: [[1, 0]] })]) {
      const e = httpEmbedder('http://e', 's', (async () => res) as unknown as typeof fetch);
      await expect(e.embed(['a', 'b'])).rejects.toBeInstanceOf(EmbedError);
    }
  });
  it('gives up after the timeout', async () => {
    const hang = (_u: string, init: RequestInit) => new Promise<Response>((_r, reject) => init.signal!.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError'))));
    const e = httpEmbedder('http://e', 's', hang as unknown as typeof fetch, 20);
    await expect(e.embed(['a'])).rejects.toMatchObject({ code: 'EMBED_TIMEOUT' });
  });
  it('an empty list costs no request', async () => {
    const fetchImpl = vi.fn();
    await expect(httpEmbedder('http://e', 's', fetchImpl as unknown as typeof fetch).embed([])).resolves.toEqual({ model: '', vectors: [] });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
