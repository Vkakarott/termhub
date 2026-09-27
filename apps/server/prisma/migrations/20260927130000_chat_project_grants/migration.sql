-- CreateTable
CREATE TABLE "chat_project_grants" (
    "id" TEXT NOT NULL,
    "conversation_id" TEXT NOT NULL,
    "project_id" TEXT NOT NULL,
    "source_action_id" TEXT,
    "granted_by" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "revoked_at" TIMESTAMP(3),
    "revoked_by" TEXT,

    CONSTRAINT "chat_project_grants_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "chat_project_grants_conversation_id_idx" ON "chat_project_grants"("conversation_id");

-- One active grant per conversation + project (spec 2026-09-26 project grant §3). Partial, so a
-- revoked grant does not stop the project from being trusted again; `grant()` revokes an
-- expired-but-unrevoked row in the same transaction. Prisma cannot express it.
CREATE UNIQUE INDEX "chat_project_grants_one_active" ON "chat_project_grants"("conversation_id", "project_id")
    WHERE "revoked_at" IS NULL;

-- AddForeignKey
ALTER TABLE "chat_project_grants" ADD CONSTRAINT "chat_project_grants_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "chat_conversations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
