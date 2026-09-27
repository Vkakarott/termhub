-- TER-301: concierge subagents panel, gate origin and resume after restart. Additive only.
CREATE TABLE "chat_subagents" (
  "id" TEXT NOT NULL,
  "conversation_id" TEXT NOT NULL,
  "task_id" TEXT NOT NULL,
  "tool_use_id" TEXT NOT NULL,
  "description" TEXT NOT NULL,
  "subagent_type" TEXT,
  "status" TEXT NOT NULL,
  "started_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "ended_at" TIMESTAMP(3),
  CONSTRAINT "chat_subagents_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "chat_subagents_conversation_id_task_id_key" ON "chat_subagents"("conversation_id", "task_id");
CREATE INDEX "chat_subagents_conversation_id_started_at_idx" ON "chat_subagents"("conversation_id", "started_at");
ALTER TABLE "chat_subagents" ADD CONSTRAINT "chat_subagents_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "chat_conversations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "chat_live_runs" (
  "conversation_id" TEXT NOT NULL,
  "user_id" TEXT NOT NULL,
  "instance_id" TEXT NOT NULL,
  "heartbeat_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "released_at" TIMESTAMP(3),
  "turns" JSONB NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "chat_live_runs_pkey" PRIMARY KEY ("conversation_id")
);
CREATE INDEX "chat_live_runs_heartbeat_at_idx" ON "chat_live_runs"("heartbeat_at");
ALTER TABLE "chat_live_runs" ADD CONSTRAINT "chat_live_runs_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "chat_conversations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "chat_actions" ADD COLUMN "tool_use_id" TEXT, ADD COLUMN "subagent_id" TEXT;
CREATE INDEX "chat_actions_conversation_id_tool_use_id_idx" ON "chat_actions"("conversation_id", "tool_use_id");
