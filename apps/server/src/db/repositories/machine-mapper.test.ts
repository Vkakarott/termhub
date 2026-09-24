import { describe, expect, it } from 'vitest';
import type { Machine as PrismaMachine } from '../../generated/prisma/client.js';
import { mapMachine } from './types.js';

const row = (over: Partial<PrismaMachine> = {}): PrismaMachine =>
  ({
    id: 'm1', name: 'mac', subtitle: null, host: null, sshUser: null, sshPort: 22, type: 'agent', os: null, capabilities: [], checkedAt: null,
    agentTokenHash: null, agentTokenCreatedAt: null, agentVersion: null, agentLastSeenAt: null, agentAutoUpdate: false, isLocal: false,
    ownerId: 'u1', createdAt: new Date('2026-09-24T00:00:00.000Z'), ...over,
  }) as PrismaMachine;

describe('mapMachine', () => {
  it('carries the subtitle, or null when there is none', () => {
    expect(mapMachine(row({ subtitle: 'MacBook do escritório' })).subtitle).toBe('MacBook do escritório');
    expect(mapMachine(row()).subtitle).toBeNull();
  });
});
