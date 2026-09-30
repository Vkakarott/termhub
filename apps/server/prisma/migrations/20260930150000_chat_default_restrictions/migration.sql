-- What a person took out of the chat's default allowances (TER-627). A new table only: the release
-- still serving during the switch never reads it, and a user with no row gets every default.
CREATE TABLE "chat_default_restrictions" (
    "user_id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "chat_default_restrictions_pkey" PRIMARY KEY ("user_id","kind")
);

ALTER TABLE "chat_default_restrictions" ADD CONSTRAINT "chat_default_restrictions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
