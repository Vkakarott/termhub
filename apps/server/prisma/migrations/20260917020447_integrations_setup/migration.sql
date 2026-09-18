-- CreateEnum
CREATE TYPE "IntegrationProvider" AS ENUM ('github', 'linear', 'jira');

-- AlterTable
ALTER TABLE "machines" ADD COLUMN     "capabilities" JSONB NOT NULL DEFAULT '[]',
ADD COLUMN     "checked_at" TIMESTAMP(3),
ADD COLUMN     "os" TEXT;

-- AlterTable
ALTER TABLE "tasks" ADD COLUMN     "external_key" TEXT;

-- CreateTable
CREATE TABLE "integrations" (
    "id" TEXT NOT NULL,
    "provider" "IntegrationProvider" NOT NULL,
    "name" TEXT NOT NULL,
    "config" JSONB NOT NULL DEFAULT '{}',
    "secret" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "integrations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "project_setups" (
    "project_id" TEXT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "data" JSONB NOT NULL DEFAULT '{}',
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "project_setups_pkey" PRIMARY KEY ("project_id")
);

-- CreateIndex
CREATE UNIQUE INDEX "tasks_project_id_external_key_key" ON "tasks"("project_id", "external_key");

-- AddForeignKey
ALTER TABLE "project_setups" ADD CONSTRAINT "project_setups_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

