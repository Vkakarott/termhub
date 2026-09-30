-- TER-477: when a pending card was last brought back to the end of the chat. Nullable, read with
-- `created_at` as the fallback, so the previous release keeps working while this one starts.
ALTER TABLE "chat_actions" ADD COLUMN "surfaced_at" TIMESTAMP(3);
ALTER TABLE "tab_questions" ADD COLUMN "surfaced_at" TIMESTAMP(3);
