-- Board hierarchy (spec 2026-09-24-board-hierarchy-design.md §8). Additive: the previous release
-- keeps reading and writing status/position/parent_id with their old meaning during the switch, and
-- the numbering trigger numbers its inserts too.

-- 1. Types, columns, table, keys
CREATE TYPE "TaskType" AS ENUM ('epic', 'story', 'task', 'subtask', 'bug', 'spike');

ALTER TABLE "tasks" ADD COLUMN "type" "TaskType" NOT NULL DEFAULT 'task',
                    ADD COLUMN "number" INTEGER NOT NULL DEFAULT 0,
                    ADD COLUMN "epic_id" TEXT,
                    ADD COLUMN "column_id" TEXT;

CREATE TABLE "task_columns" (
    "id" TEXT NOT NULL,
    "project_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "category" "TaskStatus" NOT NULL,
    "position" INTEGER NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "task_columns_pkey" PRIMARY KEY ("id"),
    -- invisible to Prisma (not modelled, never dropped by migrate)
    CONSTRAINT "task_columns_category_not_backlog" CHECK ("category" <> 'backlog')
);

ALTER TABLE "projects" ADD COLUMN "agent_column_id" TEXT;

CREATE INDEX "task_columns_project_id_position_idx" ON "task_columns"("project_id", "position");
CREATE INDEX "tasks_column_id_position_idx" ON "tasks"("column_id", "position");
CREATE INDEX "tasks_epic_id_status_position_idx" ON "tasks"("epic_id", "status", "position");

ALTER TABLE "task_columns" ADD CONSTRAINT "task_columns_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_epic_id_fkey" FOREIGN KEY ("epic_id") REFERENCES "tasks"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_column_id_fkey" FOREIGN KEY ("column_id") REFERENCES "task_columns"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "projects" ADD CONSTRAINT "projects_agent_column_id_fkey" FOREIGN KEY ("agent_column_id") REFERENCES "task_columns"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- 2. Subtasks
UPDATE "tasks" SET "type" = 'subtask' WHERE "parent_id" IS NOT NULL;

-- 3. Default columns for every project
INSERT INTO "task_columns" ("id", "project_id", "name", "category", "position")
SELECT 'tc' || p."id" || c.n, p."id", c.name, c.category::"TaskStatus", c.n - 1
  FROM "projects" p
 CROSS JOIN (VALUES (1, 'A fazer', 'todo'), (2, 'Fazendo', 'doing'), (3, 'Feito', 'done')) AS c(n, name, category);

-- 4. Top-level cards on the board: the column of their status, positions kept
UPDATE "tasks" t
   SET "column_id" = 'tc' || t."project_id" || CASE t."status" WHEN 'todo' THEN '1' WHEN 'doing' THEN '2' ELSE '3' END
 WHERE t."parent_id" IS NULL AND t."status" <> 'backlog';

-- 5. Default epic "Geral" (in the backlog) for every project with top-level cards
INSERT INTO "tasks" ("id", "project_id", "title", "status", "position", "type")
SELECT 'ep' || p."id", p."id", 'Geral', 'backlog', 0, 'epic'
  FROM "projects" p
 WHERE EXISTS (SELECT 1 FROM "tasks" t WHERE t."project_id" = p."id" AND t."parent_id" IS NULL);

UPDATE "tasks" SET "epic_id" = 'ep' || "project_id" WHERE "parent_id" IS NULL AND "type" <> 'epic';

-- 6. Numbers per project by creation (epics first); the counter continues after the highest
UPDATE "tasks" t SET "number" = n.rn
  FROM (SELECT "id", ROW_NUMBER() OVER (PARTITION BY "project_id" ORDER BY ("type" <> 'epic'), "created_at", "id") AS rn FROM "tasks") n
 WHERE n."id" = t."id";

UPDATE "projects" p SET "next_task_number" = COALESCE((SELECT MAX(t."number") FROM "tasks" t WHERE t."project_id" = p."id"), 0) + 1;

-- 7. Uniqueness, then the trigger that numbers every new row (the previous release's too)
CREATE UNIQUE INDEX "tasks_project_id_number_key" ON "tasks"("project_id", "number");

CREATE FUNCTION "tasks_assign_number"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."number" IS NULL OR NEW."number" = 0 THEN
    -- the row lock on the project serializes concurrent inserts: numbers never repeat
    UPDATE "projects" SET "next_task_number" = "next_task_number" + 1
     WHERE "id" = NEW."project_id"
    RETURNING "next_task_number" - 1 INTO NEW."number";
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER "tasks_assign_number" BEFORE INSERT ON "tasks"
  FOR EACH ROW EXECUTE FUNCTION "tasks_assign_number"();
