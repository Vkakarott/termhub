-- Additive only (spec 2026-09-26 mcp-external-tickets): the previous release ignores the new column.
ALTER TABLE "tickets" ADD COLUMN "scope" TEXT;

-- Rows synced so far carry their source's scope in meta.
UPDATE "tickets" SET "scope" = "meta"->>'scope' WHERE "scope" IS NULL AND "meta" ? 'scope';

DROP INDEX IF EXISTS "tickets_project_id_integration_id_idx";
CREATE INDEX "tickets_project_id_integration_id_scope_idx" ON "tickets"("project_id", "integration_id", "scope");
