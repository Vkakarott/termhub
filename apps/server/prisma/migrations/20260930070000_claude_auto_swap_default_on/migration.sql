-- TER-587: the automatic Claude account swap is on by default (owner decision, 2026-09-30); it stays
-- switchable per machine in Contas de IA. No machine had turned it on, so every existing row is still
-- the old default and is turned on too. The previous release reads the same column.

-- AlterTable
ALTER TABLE "machines" ALTER COLUMN "claude_auto_swap" SET DEFAULT true;

UPDATE "machines" SET "claude_auto_swap" = true WHERE "claude_auto_swap" = false;
