-- A chat message may answer another one (TER-447). Nullable columns only: the release still serving
-- during the switch neither reads nor writes them.
ALTER TABLE "chat_messages"
  ADD COLUMN "reply_to_id" TEXT,
  ADD COLUMN "reply_to_role" TEXT,
  ADD COLUMN "reply_to_excerpt" TEXT;

-- The delete of a quoted message nulls its replies' reference; without this index that is a scan.
CREATE INDEX "chat_messages_reply_to_id_idx" ON "chat_messages"("reply_to_id");

ALTER TABLE "chat_messages" ADD CONSTRAINT "chat_messages_reply_to_id_fkey"
  FOREIGN KEY ("reply_to_id") REFERENCES "chat_messages"("id") ON DELETE SET NULL ON UPDATE CASCADE;
