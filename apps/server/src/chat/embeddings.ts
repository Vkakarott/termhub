import { z } from 'zod';
import { config } from '../config.js';

export const EMBED_TIMEOUT_MS = 2000;

export class EmbedError extends Error {
  constructor(public code: string, message?: string) {
    super(message ?? code);
    this.name = 'EmbedError';
  }
}

export interface Embedder {
  embed(texts: string[]): Promise<{ model: string; vectors: number[][] }>;
}

const embedResponseSchema = z.object({
  model: z.string(),
  vectors: z.array(z.array(z.number())),
});

/**
 * Creates an HTTP embedder that posts texts to an embeddings service.
 * The service should respond with { model, dim, vectors }.
 * Returns { model, vectors } (no dim).
 * Throws EmbedError on HTTP errors, malformed responses, or count mismatches.
 */
export function httpEmbedder(url: string, secret: string, fetchImpl?: typeof fetch, timeoutMs?: number): Embedder {
  const fetch_ = fetchImpl ?? globalThis.fetch;
  const timeout = timeoutMs ?? EMBED_TIMEOUT_MS;

  return {
    async embed(texts: string[]) {
      // Empty list costs no request.
      if (texts.length === 0) {
        return { model: '', vectors: [] };
      }

      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), timeout);

      try {
        const response = await fetch_(`${url}/embed`, {
          method: 'POST',
          headers: {
            'authorization': `Bearer ${secret}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify({ texts }),
          signal: controller.signal,
        });

        if (!response.ok) {
          throw new EmbedError(`EMBED_HTTP_${response.status}`, `HTTP ${response.status}`);
        }

        let data: unknown;
        try {
          data = await response.json();
        } catch {
          throw new EmbedError('EMBED_BAD_RESPONSE', 'Failed to parse response as JSON');
        }

        const parsed = embedResponseSchema.safeParse(data);
        if (!parsed.success) {
          throw new EmbedError('EMBED_BAD_RESPONSE', 'Response does not match expected schema');
        }

        // Verify count matches.
        if (parsed.data.vectors.length !== texts.length) {
          throw new EmbedError('EMBED_BAD_RESPONSE', `Expected ${texts.length} vectors, got ${parsed.data.vectors.length}`);
        }

        return {
          model: parsed.data.model,
          vectors: parsed.data.vectors,
        };
      } catch (err) {
        // Handle abort (timeout).
        if (err instanceof DOMException && err.name === 'AbortError') {
          throw new EmbedError('EMBED_TIMEOUT');
        }

        // Handle network errors.
        if (err instanceof TypeError) {
          throw new EmbedError('EMBED_UNREACHABLE', err.message);
        }

        // Re-throw EmbedError.
        if (err instanceof EmbedError) {
          throw err;
        }

        throw new EmbedError('EMBED_UNREACHABLE', String(err));
      } finally {
        clearTimeout(timeoutId);
      }
    },
  };
}

/**
 * Returns a memoized embedder from config.embeddings, or null if unset.
 */
let cachedEmbedder: Embedder | null | undefined;

export function defaultEmbedder(): Embedder | null {
  if (cachedEmbedder === undefined) {
    if (config.embeddings) {
      cachedEmbedder = httpEmbedder(config.embeddings.url, config.embeddings.secret);
    } else {
      cachedEmbedder = null;
    }
  }
  return cachedEmbedder;
}
