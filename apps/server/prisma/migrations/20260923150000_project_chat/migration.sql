-- A chat per project (spec 2026-09-23-project-chat-design.md §3).
ALTER TABLE "chat_conversations" ADD COLUMN "project_id" TEXT;
ALTER TABLE "chat_conversations" ADD COLUMN "archived_at" TIMESTAMP(3);
ALTER TABLE "chat_conversations"
  ADD CONSTRAINT "chat_conversations_project_id_fkey"
  FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;
CREATE INDEX "chat_conversations_project_id_idx" ON "chat_conversations"("project_id");

-- One active conversation per user per scope (account-wide = project_id NULL), any number archived.
DROP INDEX IF EXISTS "chat_conversations_one_per_user";
CREATE UNIQUE INDEX "chat_conversations_one_active"
  ON "chat_conversations" ("user_id", COALESCE("project_id", ''))
  WHERE "tab_id" IS NULL AND "archived_at" IS NULL;

-- A concierge token names the conversation it runs for (spec §4.2), so the gate asks in that chat.
ALTER TABLE "api_tokens" ADD COLUMN "chat_conversation_id" TEXT;
ALTER TABLE "api_tokens"
  ADD CONSTRAINT "api_tokens_chat_conversation_id_fkey"
  FOREIGN KEY ("chat_conversation_id") REFERENCES "chat_conversations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
CREATE INDEX "api_tokens_chat_conversation_id_idx" ON "api_tokens"("chat_conversation_id");
