import { describe, expect, it } from 'vitest';
import type { Project as PrismaProject } from '../../generated/prisma/client.js';
import { publicId } from '../../public/public-id.js';
import { mapProject } from './types.js';

const row = (over: Partial<PrismaProject> = {}): PrismaProject =>
  ({
    id: 'p1', ownerId: 'u1', key: 'ENG', nextTaskNumber: 1, name: 'Engage Easy', status: 'active', description: null, isPublic: false,
    lastTerminalAt: null, createdAt: new Date('2026-09-24T00:00:00.000Z'), ...over,
  }) as PrismaProject;

describe('mapProject', () => {
  // city-by-project §2.3: the share button builds a building's link from this, with no new endpoint
  it("carries the project's building id on the public city", () => {
    expect(mapProject(row()).public_id).toBe(publicId('project', 'p1'));
    expect(mapProject(row({ id: 'p2' })).public_id).not.toBe(mapProject(row()).public_id);
  });
});
