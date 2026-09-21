-- AlterTable
-- Nullable and additive: the previous release keeps serving unmodified during blue/green. Records
-- when a decided action was re-injected into the CLI session (set before the run starts, not
-- after), so a row a busy run's lock kept from being injected survives a crash or a redeploy and is
-- picked up exactly once instead of being replayed or lost.
ALTER TABLE "chat_actions" ADD COLUMN "injected_at" TIMESTAMP(3);
