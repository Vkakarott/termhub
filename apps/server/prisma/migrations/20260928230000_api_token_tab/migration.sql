-- Tab tokens (spec 2026-09-27 agent-tab-mcp D1): a nullable, unindexed-by-FK column so the
-- previous release (blue/green) can keep serving requests untouched while this one mints them.
ALTER TABLE "api_tokens" ADD COLUMN "tab_id" TEXT;
CREATE INDEX "api_tokens_tab_id_idx" ON "api_tokens"("tab_id");
