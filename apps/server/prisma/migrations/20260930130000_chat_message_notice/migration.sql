-- TER-588: what the chat says about an answer besides its text and error code — the usage limit it hit
-- (when it resets, whether another account could take over) or the account that answered instead.
-- A nullable column only: the previous release keeps serving during the deploy and never names it.
ALTER TABLE "chat_messages" ADD COLUMN "notice" JSONB;
