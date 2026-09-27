-- Concierge memory (spec 2026-09-26 concierge memory §3). Additive only.
ALTER TABLE "users" ADD COLUMN "chat_autodecide" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "tab_questions" ADD COLUMN "auto_answer" JSONB;
ALTER TABLE "tab_questions" ADD COLUMN "answered_via" TEXT;
ALTER TABLE "tab_questions" ADD COLUMN "woken_at" TIMESTAMP(3);
ALTER TABLE "chat_decisions" ADD COLUMN "auto_count" INTEGER NOT NULL DEFAULT 0;

CREATE TABLE "memory_items" (
    "id" TEXT NOT NULL,
    "owner_id" TEXT NOT NULL,
    "project_id" TEXT,
    "kind" TEXT NOT NULL,
    "source_id" TEXT NOT NULL,
    "chunk_index" INTEGER NOT NULL DEFAULT 0,
    "title" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "trust" TEXT NOT NULL,
    "content_hash" TEXT NOT NULL,
    "source_hash" TEXT,
    "embedding" vector(384),
    "embed_model" TEXT,
    "source_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "memory_items_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "memory_items_kind_source_id_chunk_index_key" ON "memory_items"("kind", "source_id", "chunk_index");
CREATE INDEX "memory_items_owner_id_kind_idx" ON "memory_items"("owner_id", "kind");
CREATE INDEX "memory_items_owner_id_project_id_idx" ON "memory_items"("owner_id", "project_id");
ALTER TABLE "memory_items" ADD CONSTRAINT "memory_items_owner_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "memory_items" ADD CONSTRAINT "memory_items_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;
