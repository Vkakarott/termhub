-- TER-315: how full a chat's CLI session context is. Nullable columns only, so the previous release
-- keeps reading and writing chat_conversations unchanged while this one migrates.
ALTER TABLE "chat_conversations" ADD COLUMN "context_tokens" INTEGER,
ADD COLUMN "context_window" INTEGER;
