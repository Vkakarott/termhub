import type { PrismaClient } from '../prisma.js';
import { newId } from '../../lib/ids.js';
import { decryptSecret, encryptSecret } from '../../lib/crypto.js';

export type IntegrationProvider = 'github' | 'linear' | 'jira';

export interface Integration {
  id: string;
  provider: IntegrationProvider;
  name: string;
  config: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

const map = (i: { id: string; provider: IntegrationProvider; name: string; config: unknown; createdAt: Date; updatedAt: Date }): Integration => ({
  id: i.id,
  provider: i.provider,
  name: i.name,
  config: (i.config ?? {}) as Record<string, unknown>,
  created_at: i.createdAt.toISOString(),
  updated_at: i.updatedAt.toISOString(),
});

/** Segredo nunca sai do repositório em claro exceto via getSecret(). */
export class IntegrationsRepository {
  constructor(private db: PrismaClient) {}

  async list(): Promise<Integration[]> {
    return (await this.db.integration.findMany({ orderBy: { createdAt: 'asc' } })).map(map);
  }

  async findById(id: string): Promise<Integration | undefined> {
    const i = await this.db.integration.findUnique({ where: { id } });
    return i ? map(i) : undefined;
  }

  async getSecret(id: string): Promise<string | undefined> {
    const i = await this.db.integration.findUnique({ where: { id }, select: { secret: true } });
    return i ? decryptSecret(i.secret) : undefined;
  }

  async create(input: { provider: IntegrationProvider; name: string; config: Record<string, unknown>; secret: string }): Promise<Integration> {
    const i = await this.db.integration.create({
      data: { id: newId(), provider: input.provider, name: input.name, config: input.config as object, secret: encryptSecret(input.secret) },
    });
    return map(i);
  }

  async update(id: string, patch: { name?: string; config?: Record<string, unknown>; secret?: string }): Promise<Integration | undefined> {
    const i = await this.db.integration.update({
      where: { id },
      data: {
        ...(patch.name !== undefined ? { name: patch.name } : {}),
        ...(patch.config !== undefined ? { config: patch.config as object } : {}),
        ...(patch.secret ? { secret: encryptSecret(patch.secret) } : {}),
      },
    });
    return map(i);
  }

  async delete(id: string): Promise<boolean> {
    return (await this.db.integration.deleteMany({ where: { id } })).count > 0;
  }
}
