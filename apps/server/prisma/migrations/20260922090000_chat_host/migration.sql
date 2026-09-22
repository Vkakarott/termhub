-- The chat now runs on the user's own machine, on their own account (spec §3/§7): the conversation
-- stores the host (machine_id, which existed unused) and the AI account on that host (ai_account_id,
-- new).
--
-- Safe to run twice, but read that as "a second run ends in the same state and raises no error", not
-- as "every statement is conditional": the column, the foreign keys and the two plain indexes are
-- guarded and do nothing the second time, while the partial unique index at the bottom really is
-- dropped and recreated on every run (see the note there).

-- AlterTable: the AI account on the host. Null = the machine's default Claude config dir.
ALTER TABLE "chat_conversations" ADD COLUMN IF NOT EXISTS "ai_account_id" TEXT;

-- AddForeignKey: deleting the machine or the account nulls the field, so the next message asks the
-- user to choose again instead of trying to run on something that is gone. machine_id never had a
-- foreign key (migration 20260921090000 created the column while it was unused), so it gets one here
-- together with the account's.
-- `conrelid` ties each lookup to *this* table as the current search_path resolves it — the same table
-- the ALTER TABLE below would touch. Matching on the name alone would let a constraint of the same name
-- in another schema answer for ours, and the branch would then skip an ADD CONSTRAINT that never ran:
-- no error, and no foreign key.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM "pg_constraint" WHERE "conname" = 'chat_conversations_machine_id_fkey' AND "conrelid" = '"chat_conversations"'::regclass) THEN
    ALTER TABLE "chat_conversations"
      ADD CONSTRAINT "chat_conversations_machine_id_fkey" FOREIGN KEY ("machine_id") REFERENCES "machines"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM "pg_constraint" WHERE "conname" = 'chat_conversations_ai_account_id_fkey' AND "conrelid" = '"chat_conversations"'::regclass) THEN
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
-- This pair is the one thing here that is *not* inert on a second run: it drops the index and builds it
-- again. `prisma migrate deploy` runs the file in a transaction, so nobody ever sees the table without
-- the index; a hand `psql` run of this file does have that instant, which is fine for the one thing
-- this is ever run by hand (a dry idempotency check on a scratch database) and worth knowing before
-- anyone pastes it into a live one.
DROP INDEX IF EXISTS "chat_conversations_one_per_user";
CREATE UNIQUE INDEX IF NOT EXISTS "chat_conversations_one_per_user" ON "chat_conversations"("user_id") WHERE "tab_id" IS NULL;
