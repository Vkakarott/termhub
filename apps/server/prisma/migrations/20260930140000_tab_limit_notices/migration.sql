-- Usage-limit cards in a project's chat (TER-589). A new table only: the release still serving during
-- the switch never reads it.
CREATE TABLE "tab_limit_notices" (
    "id" TEXT NOT NULL,
    "tab_id" TEXT NOT NULL,
    "project_id" TEXT NOT NULL,
    "conversation_id" TEXT NOT NULL,
    "limited_at" TIMESTAMP(3) NOT NULL,
    "payload" JSONB NOT NULL,
    "status" TEXT NOT NULL,
    "result" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "closed_at" TIMESTAMP(3),

    CONSTRAINT "tab_limit_notices_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "tab_limit_notices_tab_id_limited_at_key" ON "tab_limit_notices"("tab_id", "limited_at");
CREATE INDEX "tab_limit_notices_conversation_id_status_idx" ON "tab_limit_notices"("conversation_id", "status");

ALTER TABLE "tab_limit_notices" ADD CONSTRAINT "tab_limit_notices_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "tab_limit_notices" ADD CONSTRAINT "tab_limit_notices_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "chat_conversations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
