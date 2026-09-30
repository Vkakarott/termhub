-- TER-179: which subagent a card belongs to, and which agents are in a permission queue (spec
-- 2026-09-30 tab questions per subagent §2). The previous release keeps serving and names neither.
ALTER TABLE "tab_questions"
  ADD COLUMN "agent_id" TEXT,
  ADD COLUMN "queue_agents" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
