-- AlterEnum
ALTER TYPE "MachineType" ADD VALUE 'agent';

-- AlterTable
ALTER TABLE "machines" ADD COLUMN     "agent_token_hash" TEXT,
ADD COLUMN     "agent_token_created_at" TIMESTAMP(3),
ADD COLUMN     "agent_version" TEXT,
ADD COLUMN     "agent_last_seen_at" TIMESTAMP(3);

-- CreateIndex
CREATE UNIQUE INDEX "machines_agent_token_hash_key" ON "machines"("agent_token_hash");
