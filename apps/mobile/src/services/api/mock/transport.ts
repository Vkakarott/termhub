// `createMockTransport` — the in-memory "server" (design spec §4.2). Answers the same URLs
// `FetchTransport` would reach, over one `MockState` per call: deterministic, resettable, and
// gone the moment the app process restarts (no state survives on purpose — see `state.ts`).
import { z } from 'zod';
import { canonicalHtu, parseAppHeader } from '../contract';
import type { Transport, TransportFetchInput, TransportFetchResult, TransportSocket, TransportSocketHandlers } from '../transport';
import { createMockControls, type MockControls } from './controls';
import { registerDeviceRoutes } from './handlers/devices';
import { registerMeRoutes } from './handlers/me';
import { registerSessionRoutes } from './handlers/session';
import { createRouter } from './router';
import { createMockState, WireError } from './state';

export interface CreateMockTransportOptions {
  /** Milliseconds, uniform random per `fetch` call. Defaults to `[150, 400]` (design spec §4.2).
   * `[0, 0]` still resolves asynchronously — a resolved promise, never a timer (ruling 3). */
  latency?: [number, number];
  /** Milliseconds; defaults to `Date.now`. A test clock, so expiry and lock windows are
   * deterministic and drivable by the caller. */
  now?: () => number;
}

function lowerCaseHeaders(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) out[key.toLowerCase()] = value;
  return out;
}

export function createMockTransport(opts: CreateMockTransportOptions = {}): Transport & { controls: MockControls } {
  const state = createMockState();
  const now = opts.now ?? Date.now;
  const [minLatency, maxLatency] = opts.latency ?? [150, 400];

  const router = createRouter();
  registerDeviceRoutes(router, state);
  registerSessionRoutes(router, state);
  registerMeRoutes(router, state);

  const waitForLatency = (): Promise<void> => {
    const ms = minLatency + Math.random() * (maxLatency - minLatency);
    // A resolved promise, not `setTimeout(fn, 0)`: the caller still awaits a microtask (genuinely
    // asynchronous), but nothing here needs Jest fake timers to settle (ruling 3).
    return ms <= 0 ? Promise.resolve() : new Promise((resolve) => setTimeout(resolve, ms));
  };

  const respond = (status: number, body: unknown, extraHeaders: Record<string, string> = {}): TransportFetchResult => ({
    status,
    headers: { date: new Date(now()).toUTCString(), 'content-type': 'application/json', ...extraHeaders },
    text: JSON.stringify(body),
  });

  const fetchImpl = async (input: TransportFetchInput): Promise<TransportFetchResult> => {
    await waitForLatency();

    const url = new URL(input.url);
    const headers = lowerCaseHeaders(input.headers);

    try {
      if (!parseAppHeader(headers['x-termhub-app'])) {
        throw new WireError(400, 'APP_HEADER', 'Atualize o app do termhub para continuar.');
      }

      const matched = router.match(input.method, url.pathname);
      if (!matched) throw new WireError(404, 'NOT_FOUND', 'Rota não encontrada.');

      const query: Record<string, string> = {};
      url.searchParams.forEach((value, key) => {
        query[key] = value;
      });

      const body = input.body ? JSON.parse(input.body) : undefined;
      const result = matched.handler({
        state,
        now,
        headers,
        body,
        params: matched.params,
        query,
        path: url.pathname,
        // Derived from the request's own origin, not a fixed host (ruling revision): the client
        // always signs its DPoP proof with the same base it calls, so this is the only base that
        // agrees with it regardless of what `EXPO_PUBLIC_TERMHUB_URL` (e.g. `http://localhost:3000`
        // in `.env.example`) points at.
        htu: canonicalHtu(url.origin, url.pathname),
      });
      return respond(result.status, result.body);
    } catch (err) {
      if (err instanceof WireError) {
        const extraHeaders: Record<string, string> = {};
        if (err.extra && typeof err.extra.retry_after === 'number') {
          extraHeaders['retry-after'] = String(err.extra.retry_after);
        }
        return respond(err.status, { error: err.error, code: err.code, ...err.extra }, extraHeaders);
      }
      if (err instanceof z.ZodError) {
        return respond(400, { error: 'Dados inválidos.', code: 'VALIDATION' });
      }
      throw err;
    }
  };

  const connectImpl = (_url: string, _headers: Record<string, string>, handlers: TransportSocketHandlers): TransportSocket => {
    // Stub for this task: the real fake socket (upgrade check, `hello`, chat/notification
    // frames) is Task 9's. Closing with `4401` on the next tick lets the client's "revoked"
    // handling be exercised even before that socket exists (ruling 1).
    const timer = setTimeout(() => handlers.onClose(4401), 0);
    return { close: () => clearTimeout(timer) };
  };

  return {
    fetch: fetchImpl,
    connect: connectImpl,
    controls: createMockControls(state, now),
  };
}
