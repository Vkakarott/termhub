-- The chat now runs on the user's own machine, on their own account (spec §3/§7): the conversation
-- stores the host (machine_id, which existed unused) and the AI account on that host (ai_account_id,
-- new). Written to be safe to run twice, like the repo's other data migrations: the column, the
-- foreign keys, the indexes and the swap of the partial unique index are all conditional.

-- AlterTable: the AI account on the host. Null = the machine's default Claude config dir.
ALTER TABLE "chat_conversations" ADD COLUMN IF NOT EXISTS "ai_account_id" TEXT;

-- AddForeignKey: deleting the machine or the account nulls the field, so the next message asks the
-- user to choose again instead of trying to run on something that is gone. machine_id never had a
-- foreign key (migration 20260921090000 created the column while it was unused), so it gets one here
-- together with the account's.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM "pg_constraint" WHERE "conname" = 'chat_conversations_machine_id_fkey') THEN
    ALTER TABLE "chat_conversations"
      ADD CONSTRAINT "chat_conversations_machine_id_fkey" FOREIGN KEY ("machine_id") REFERENCES "machines"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM "pg_constraint" WHERE "conname" = 'chat_conversations_ai_account_id_fkey') THEN
    ALTER TABLE "chat_conversations"
      ADD CONSTRAINT "chat_conversations_ai_account_id_fkey" FOREIGN KEY ("ai_account_id") REFERENCES "ai_accounts"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;

-- Deleting a machine or an account nulls the column on every conversation pointing at it; these
-- indexes are what keeps that from scanning the whole table.
CREATE INDEX IF NOT EXISTS "chat_conversations_machine_id_idx" ON "chat_conversations"("machine_id");
CREATE INDEX IF NOT EXISTS "chat_conversations_ai_account_id_idx" ON "chat_conversations"("ai_account_id");

-- DropIndex/CreateIndex: "one conversation per user" can no longer depend on machine_id being null.
-- The old index (WHERE machine_id IS NULL AND tab_id IS NULL) would stop covering a conversation the
-- moment its host was chosen — and with it the database guarantee that keeps getOrCreateForUser from
-- letting two browser tabs create two conversations. machine_id is the host now, not a conversation
-- scope; only tab_id still is.
-- No existing row is affected: machine_id is null on all of them today (the column was never used),
-- and every conversation is still read by user_id, so the conversations already out there keep working.
DROP INDEX IF EXISTS "chat_conversations_one_per_user";
CREATE UNIQUE INDEX IF NOT EXISTS "chat_conversations_one_per_user" ON "chat_conversations"("user_id") WHERE "tab_id" IS NULL;
