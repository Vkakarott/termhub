-- AlterEnum
ALTER TYPE "TaskStatus" ADD VALUE 'backlog';

-- AlterTable
ALTER TABLE "tasks" ADD COLUMN     "tab_id" TEXT;

-- CreateTable
CREATE TABLE "tickets" (
    "id" TEXT NOT NULL,
    "project_id" TEXT NOT NULL,
    "integration_id" TEXT NOT NULL,
    "provider" "IntegrationProvider" NOT NULL,
    "external_key" TEXT NOT NULL,
    "identifier" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "url" TEXT NOT NULL,
    "state" TEXT NOT NULL,
    "status" "TaskStatus" NOT NULL,
    "meta" JSONB NOT NULL DEFAULT '{}',
    "task_id" TEXT,
    "synced_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tickets_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "tickets_task_id_key" ON "tickets"("task_id");

-- CreateIndex
CREATE INDEX "tickets_project_id_integration_id_idx" ON "tickets"("project_id", "integration_id");

-- CreateIndex
CREATE UNIQUE INDEX "tickets_project_id_external_key_key" ON "tickets"("project_id", "external_key");

-- AddForeignKey
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_tab_id_fkey" FOREIGN KEY ("tab_id") REFERENCES "tabs"("id") ON DELETE SET NULL ON UPDATE CASCADE;

