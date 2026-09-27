import { z } from 'zod';
import { config } from '../config.js';

export const EMBED_TIMEOUT_MS = 2000;

export class EmbedError extends Error {
  constructor(public code: string, message?: string) {
    super(message ?? code);
    this.name = 'EmbedError';
  }
}

/**
 * Rejects with `EmbedError('SUGGEST_TIMEOUT')` if `p` has not settled within `ms`, calling `onTimeout`
 * right before doing so; `p` itself keeps running (there is no cancelling an in-flight fetch or query
 * from here), but the caller stops waiting — `onTimeout` is how it tells `p`'s continuation that.
 * Shared by every embedding caller (decision suggestions, decision/memory-item embed steps) so a slow
 * or hanging embed service never holds one of them up past its own budget.
 */
export function withTimeout<T>(p: Promise<T>, ms: number, onTimeout: () => void): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      onTimeout();
      reject(new EmbedError('SUGGEST_TIMEOUT'));
    }, ms);
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

/** The failure code worth logging: an `EmbedError`'s own code, a Prisma error's `.code`, else a
 *  generic one — never the error's `message`, which may quote the question, the answer or a chunk of
 *  indexed text. Shared by every embedding caller for the same reason as `withTimeout`. */
export function memoryCode(err: unknown): string {
  if (err instanceof EmbedError) return err.code;
  if (typeof err === 'object' && err !== null && 'code' in err && typeof (err as { code: unknown }).code === 'string') {
    return (err as { code: string }).code;
  }
  return 'SUGGEST_FAILED';
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
