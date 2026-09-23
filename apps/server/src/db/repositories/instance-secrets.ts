import type { PrismaClient } from '../prisma.js';

/** Secrets the instance mints for itself on first boot and keeps for good (see `InstanceSecret`). */
export class InstanceSecretsRepository {
  constructor(private db: PrismaClient) {}

  /**
   * The secret stored under `name`, created from `generate()` if there is none yet. Insert-if-absent
   * (`ON CONFLICT DO NOTHING`) then read: two containers booting at once both write a candidate, one
   * wins, and both read back the winner — so blue and green always end up with the same value.
   */
  async ensure(name: string, generate: () => string): Promise<string> {
    await this.db.instanceSecret.createMany({ data: [{ name, value: generate() }], skipDuplicates: true });
    const row = await this.db.instanceSecret.findUniqueOrThrow({ where: { name } });
    return row.value;
  }
}
