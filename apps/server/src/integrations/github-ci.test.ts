import { describe, expect, it, vi } from 'vitest';
import { createGithubCiClient, GithubCiError } from './github-ci.js';

const json = (status: number, body: unknown, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

describe('github CI client', () => {
  it('lists recent pulls with the ETag and returns the new one', async () => {
    const fetchImpl = vi.fn(async () => json(200, [{ number: 7, html_url: 'u', title: 't', body: null, state: 'open', draft: false, merged_at: null, merge_commit_sha: null, head: { ref: 'TER-1', sha: 'abc' } }], { etag: 'W/"2"' }));
    const page = await createGithubCiClient(fetchImpl).listPulls('tok', 'acme/app', 'W/"1"');
    expect(page).toMatchObject({ notModified: false, etag: 'W/"2"', pulls: [{ number: 7 }] });
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.github.com/repos/acme/app/pulls?state=all&sort=updated&direction=desc&per_page=30');
    expect(new Headers(init.headers).get('if-none-match')).toBe('W/"1"');
    expect(new Headers(init.headers).get('authorization')).toBe('Bearer tok');
  });

  it('reads 304 as not modified', async () => {
    const page = await createGithubCiClient(vi.fn(async () => new Response(null, { status: 304 }))).listPulls('tok', 'acme/app', 'W/"1"');
    expect(page).toEqual({ notModified: true });
  });

  it('lists workflow runs of a commit', async () => {
    const fetchImpl = vi.fn(async () => json(200, { workflow_runs: [{ id: 1, name: 'CI', path: '.github/workflows/ci.yml', status: 'completed', conclusion: 'success', html_url: 'r', created_at: '2026-09-27T12:00:00Z', extra: 1 }] }));
    const runs = await createGithubCiClient(fetchImpl).listRuns('tok', 'acme/app', 'abc');
    expect(runs).toEqual([{ id: 1, name: 'CI', path: '.github/workflows/ci.yml', status: 'completed', conclusion: 'success', html_url: 'r', created_at: '2026-09-27T12:00:00Z' }]);
    expect(fetchImpl.mock.calls[0][0]).toBe('https://api.github.com/repos/acme/app/actions/runs?head_sha=abc&per_page=50');
  });

  it('types auth, not found and rate-limit failures', async () => {
    const reset = String(Math.floor(Date.UTC(2026, 8, 27, 13) / 1000));
    const cases: Array<[Response, string]> = [
      [json(401, {}), 'auth'],
      [json(404, {}), 'not_found'],
      [json(403, {}, { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': reset }), 'rate_limited'],
      [json(403, {}), 'auth'],
      [json(500, {}), 'http'],
    ];
    for (const [res, kind] of cases) {
      const err = await createGithubCiClient(vi.fn(async () => res)).listRuns('tok', 'acme/app', 'abc').catch((e: unknown) => e);
      expect(err).toBeInstanceOf(GithubCiError);
      expect((err as GithubCiError).kind).toBe(kind);
    }
  });

  it('types a secondary rate limit (403 or 429 with retry-after) as rate_limited until now + retry-after', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-09-27T12:00:00Z'));
    try {
      for (const status of [403, 429]) {
        const err = (await createGithubCiClient(vi.fn(async () => json(status, {}, { 'retry-after': '120' }))).listRuns('tok', 'acme/app', 'abc').catch((e: unknown) => e)) as GithubCiError;
        expect(err.kind).toBe('rate_limited');
        expect(err.resetAt).toEqual(new Date('2026-09-27T12:02:00Z'));
      }
    } finally {
      vi.useRealTimers();
    }
  });

  it('never puts the token in an error message', async () => {
    const err = (await createGithubCiClient(vi.fn(async () => json(401, { message: 'Bad credentials' }))).listPulls('secret-token', 'acme/app', null).catch((e: unknown) => e)) as Error;
    expect(err.message).not.toContain('secret-token');
  });
});
