-- AlterTable
ALTER TABLE "api_tokens" ADD COLUMN "gated" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "chat_actions" (
    "id" TEXT NOT NULL,
    "conversation_id" TEXT NOT NULL,
    "message_id" TEXT,
    "tool" TEXT NOT NULL,
    "args" JSONB NOT NULL,
    "class" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "idempotency_key" TEXT,
    "machine_id" TEXT,
    "project_id" TEXT,
    "tab_id" TEXT,
    "error_code" TEXT,
    "duration_ms" INTEGER,
    "decided_by" TEXT,
    "decided_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "chat_actions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "chat_actions_conversation_id_created_at_idx" ON "chat_actions"("conversation_id", "created_at");

-- One open row per proposed action: a model that retries, or two conversations proposing the same
-- thing, must not produce two questions. Partial, because a decided row must not block the action
-- from ever being proposed again. Prisma cannot express a partial index, so it lives only here.
CREATE UNIQUE INDEX "chat_actions_one_open_per_key" ON "chat_actions"("conversation_id", "idempotency_key")
    WHERE "status" IN ('pending', 'approved') AND "idempotency_key" IS NOT NULL;

-- AddForeignKey
ALTER TABLE "chat_actions" ADD CONSTRAINT "chat_actions_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "chat_conversations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
