-- Chat decision memory (spec 2026-09-26). Needs the pgvector image (docker/db).
CREATE EXTENSION IF NOT EXISTS vector;

ALTER TABLE "users" ADD COLUMN "chat_suggestions" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "tab_questions" ADD COLUMN "suggestion" JSONB;

CREATE TABLE "chat_decisions" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "project_id" TEXT,
    "conversation_id" TEXT,
    "tab_question_id" TEXT,
    "question_index" INTEGER NOT NULL,
    "header" TEXT NOT NULL,
    "question" TEXT NOT NULL,
    "options" JSONB NOT NULL,
    "multi_select" BOOLEAN NOT NULL,
    "answer" JSONB NOT NULL,
    "embedding" vector(384),
    "embed_model" TEXT,
    "suggested_count" INTEGER NOT NULL DEFAULT 0,
    "accepted_count" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "chat_decisions_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "chat_decisions_user_id_created_at_idx" ON "chat_decisions"("user_id", "created_at");
-- One decision per question of a tab question: recording and the backfill are idempotent.
CREATE UNIQUE INDEX "chat_decisions_tab_question_id_question_index_key" ON "chat_decisions"("tab_question_id", "question_index") WHERE "tab_question_id" IS NOT NULL;
CREATE INDEX "chat_decisions_embedding_idx" ON "chat_decisions" USING hnsw ("embedding" vector_cosine_ops);
ALTER TABLE "chat_decisions" ADD CONSTRAINT "chat_decisions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "chat_decisions" ADD CONSTRAINT "chat_decisions_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "chat_decisions" ADD CONSTRAINT "chat_decisions_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "chat_conversations"("id") ON DELETE SET NULL ON UPDATE CASCADE;
