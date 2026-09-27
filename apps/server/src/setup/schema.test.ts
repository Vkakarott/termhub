import { describe, expect, it } from 'vitest';
import { normalizeSetup, setupInputSchema, withLegacyMirror, SETUP_VERSION } from './schema.js';

const legacy = { provider: 'linear', integration_id: 'i1', scope: 'EI', filter: null, include_done: true, sync_minutes: 15 };

describe('setup ticket sources', () => {
  it('rebuilds sources when only tickets is present (saved by the previous release)', () => {
    const d = normalizeSetup({ tickets: legacy }, 1);
    expect(d.ticket_sources).toEqual([{ provider: 'linear', integration_id: 'i1', scope: 'EI', filter: null, sync_minutes: 15 }]);
    expect(d.tickets).toEqual({ provider: 'linear', integration_id: 'i1', scope: 'EI', filter: null, include_done: false, sync_minutes: 15 });
  });

  it('keeps explicit sources and mirrors the first into tickets', () => {
    const d = normalizeSetup({ tickets: null, ticket_sources: [
      { provider: 'github', integration_id: 'g', scope: 'acme/api', filter: null, sync_minutes: 0 },
      { provider: 'github', integration_id: 'g', scope: 'acme/web', filter: null, sync_minutes: 0 },
    ] }, 2);
    expect(d.ticket_sources).toHaveLength(2);
    expect(d.tickets?.scope).toBe('acme/api');
  });

  it('an explicit empty list stays empty even with a stale tickets', () => {
    expect(normalizeSetup({ tickets: legacy, ticket_sources: [] }, 2).ticket_sources).toEqual([]);
  });

  it('withLegacyMirror writes null when there is no source', () => {
    expect(withLegacyMirror(normalizeSetup({}, 2)).tickets).toBeNull();
  });

  it('refuses the same integration and scope twice', () => {
    const src = { provider: 'github', integration_id: 'g', scope: 'acme/api' };
    const r = setupInputSchema.safeParse({ ticket_sources: [src, { ...src, scope: ' acme/api ' }] });
    expect(r.success).toBe(false);
    expect(r.error?.issues[0].message).toBe('Fonte de tickets repetida');
  });
});

describe('setup repo.deploy_workflow', () => {
  it('defaults to null for a setup saved before the field existed', () => {
    const data = normalizeSetup({ repo: { integration_id: 'i1', full_name: 'acme/app' } }, SETUP_VERSION);
    expect(data.repo?.deploy_workflow).toBeNull();
  });
  it('keeps a trimmed workflow name', () => {
    const data = normalizeSetup({ repo: { integration_id: 'i1', full_name: 'acme/app', deploy_workflow: '  deploy.yml ' } }, SETUP_VERSION);
    expect(data.repo?.deploy_workflow).toBe('deploy.yml');
  });
});
