-- CreateTable
CREATE TABLE "chat_conversations" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "title" TEXT,
    "cli_session_id" TEXT,
    "model" TEXT,
    "machine_id" TEXT,
    "tab_id" TEXT,
    "review_mode" BOOLEAN NOT NULL DEFAULT false,
    "last_message_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "chat_conversations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "chat_messages" (
    "id" TEXT NOT NULL,
    "conversation_id" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "usage" JSONB,
    "error_code" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "chat_messages_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "chat_conversations_user_id_created_at_idx" ON "chat_conversations"("user_id", "created_at");

-- CreateIndex
CREATE INDEX "chat_messages_conversation_id_created_at_idx" ON "chat_messages"("conversation_id", "created_at");

-- AddForeignKey
ALTER TABLE "chat_conversations" ADD CONSTRAINT "chat_conversations_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "chat_messages" ADD CONSTRAINT "chat_messages_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "chat_conversations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ── Default grants for the new resource (admins bypass the matrix) ─────────────
INSERT INTO "permissions" ("id", "resource", "action", "role_id")
SELECT 'perm_' || r.prefix || '_chat_' || a, 'chat', a, r.role_id
FROM (VALUES ('auth', 'role_authenticated'), ('mgr', 'role_manager')) AS r(prefix, role_id),
     unnest(ARRAY['create','read','update','delete']) AS a
WHERE EXISTS (SELECT 1 FROM "roles" WHERE "id" = r.role_id)
ON CONFLICT DO NOTHING;
