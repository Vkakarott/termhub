-- TER-386: a standing "yes" per user + project + kind, with no expiry (spec 2026-09-28 standing grants §3).
CREATE TABLE "chat_standing_grants" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "project_id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "conversation_id" TEXT,
    "source_action_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revoked_at" TIMESTAMP(3),
    "revoked_by" TEXT,
    CONSTRAINT "chat_standing_grants_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "chat_standing_grants_user_id_project_id_idx" ON "chat_standing_grants"("user_id", "project_id");
-- One active grant per user + project + kind. Partial (Prisma cannot express it): a revoked row never
-- blocks granting again; `grant()` revokes the previous active row in the same transaction.
CREATE UNIQUE INDEX "chat_standing_grants_one_active" ON "chat_standing_grants"("user_id", "project_id", "kind") WHERE "revoked_at" IS NULL;
ALTER TABLE "chat_standing_grants" ADD CONSTRAINT "chat_standing_grants_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "chat_standing_grants" ADD CONSTRAINT "chat_standing_grants_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "chat_standing_grants" ADD CONSTRAINT "chat_standing_grants_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "chat_conversations"("id") ON DELETE SET NULL ON UPDATE CASCADE;
-- Budgets of a standing grant are counted across conversations (`countByGrantSince`).
CREATE INDEX "chat_actions_grant_id_created_at_idx" ON "chat_actions"("grant_id", "created_at");
