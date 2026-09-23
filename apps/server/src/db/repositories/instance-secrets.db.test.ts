import { PrismaPg } from '@prisma/adapter-pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaClient } from '../../generated/prisma/client.js';
import { newId } from '../../lib/ids.js';
import { InstanceSecretsRepository } from './instance-secrets.js';

// Needs a migrated Postgres: TERMHUB_DB_TESTS=1 DATABASE_URL=… (see README → Development).
describe.skipIf(process.env.TERMHUB_DB_TESTS !== '1')('InstanceSecretsRepository (Postgres)', () => {
  let db: PrismaClient;
  let repo: InstanceSecretsRepository;

  beforeAll(() => {
    db = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }) });
    repo = new InstanceSecretsRepository(db);
  });

  afterAll(async () => {
    await db?.$disconnect();
  });

  it('creates the secret once and keeps it', async () => {
    const name = `test-${newId()}`;
    try {
      expect(await repo.ensure(name, () => 'first')).toBe('first');
      expect(await repo.ensure(name, () => 'second')).toBe('first');
    } finally {
      await db.instanceSecret.deleteMany({ where: { name } });
    }
  });

  // Blue and green boot side by side during a switch: both must end up with the same key.
  it('converges two containers booting at once on a single value', async () => {
    const name = `test-${newId()}`;
    try {
      const got = await Promise.all(['a', 'b', 'c', 'd'].map((v) => repo.ensure(name, () => v)));
      expect(new Set(got).size).toBe(1);
    } finally {
      await db.instanceSecret.deleteMany({ where: { name } });
    }
  });
});
