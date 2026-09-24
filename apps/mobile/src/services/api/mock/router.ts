// A tiny method+path router keyed on segments (`:id` captures) — enough for the dozen routes the
// mock answers (design spec §4.2), nothing more.
import type { MockState } from './state';

export interface MockContext {
  state: MockState;
  /** Milliseconds, the same clock `createMockTransport`'s `opts.now` supplies. */
  now: () => number;
  /** Lower-cased header names, exactly as `transport.ts` hands them down. */
  headers: Record<string, string>;
  body: unknown;
  params: Record<string, string>;
  query: Record<string, string>;
  /** The request's pathname, no query string. */
  path: string;
  /** `canonicalHtu(MOCK_BASE_URL, path)` — what every DPoP proof in this request must have signed. */
  htu: string;
}

export type RouteHandler = (ctx: MockContext) => { status: number; body: unknown };

interface RouteEntry {
  method: string;
  segments: string[];
  handler: RouteHandler;
}

export class MockRouter {
  private readonly routes: RouteEntry[] = [];

  route(method: string, path: string, handler: RouteHandler): void {
    this.routes.push({ method, segments: path.split('/').filter(Boolean), handler });
  }

  match(method: string, pathname: string): { handler: RouteHandler; params: Record<string, string> } | null {
    const segments = pathname.split('/').filter(Boolean);
    for (const entry of this.routes) {
      if (entry.method !== method || entry.segments.length !== segments.length) continue;
      const params: Record<string, string> = {};
      let matched = true;
      for (let i = 0; i < segments.length; i++) {
        const routeSegment = entry.segments[i]!;
        const pathSegment = segments[i]!;
        if (routeSegment.startsWith(':')) {
          params[routeSegment.slice(1)] = decodeURIComponent(pathSegment);
        } else if (routeSegment !== pathSegment) {
          matched = false;
          break;
        }
      }
      if (matched) return { handler: entry.handler, params };
    }
    return null;
  }
}

export function createRouter(): MockRouter {
  return new MockRouter();
}
