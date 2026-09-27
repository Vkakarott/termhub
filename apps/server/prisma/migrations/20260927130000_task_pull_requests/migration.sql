-- CI panel (spec 2026-09-26 progress-panel §5.2): PRs linked to cards. New table only: the previous release ignores it.
-- CreateTable
CREATE TABLE "task_pull_requests" (
    "id" TEXT NOT NULL,
    "project_id" TEXT NOT NULL,
    "task_id" TEXT NOT NULL,
    "repo" TEXT NOT NULL,
    "number" INTEGER NOT NULL,
    "url" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "head_ref" TEXT NOT NULL,
    "head_sha" TEXT NOT NULL,
    "state" TEXT NOT NULL,
    "draft" BOOLEAN NOT NULL DEFAULT false,
    "merged_at" TIMESTAMP(3),
    "merge_commit_sha" TEXT,
    "ci_state" TEXT NOT NULL DEFAULT 'none',
    "ci_summary" JSONB NOT NULL DEFAULT '{}',
    "deploy_state" TEXT NOT NULL DEFAULT 'none',
    "deploy_url" TEXT,
    "synced_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "task_pull_requests_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "task_pull_requests_project_id_state_idx" ON "task_pull_requests"("project_id", "state");

-- CreateIndex
CREATE UNIQUE INDEX "task_pull_requests_task_id_repo_number_key" ON "task_pull_requests"("task_id", "repo", "number");

-- AddForeignKey
ALTER TABLE "task_pull_requests" ADD CONSTRAINT "task_pull_requests_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "task_pull_requests" ADD CONSTRAINT "task_pull_requests_task_id_fkey" FOREIGN KEY ("task_id") REFERENCES "tasks"("id") ON DELETE CASCADE ON UPDATE CASCADE;

