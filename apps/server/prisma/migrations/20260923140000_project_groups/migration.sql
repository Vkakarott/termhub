-- Sidebar project groups (Favoritos + the user's own). Additive: two new tables the previous
-- container never reads, so both colors of a blue/green switch run against it safely.

-- CreateTable
CREATE TABLE "project_groups" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "system_key" TEXT,
    "position" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "project_groups_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "project_group_items" (
    "group_id" TEXT NOT NULL,
    "project_id" TEXT NOT NULL,
    "position" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "project_group_items_pkey" PRIMARY KEY ("group_id","project_id")
);

-- CreateIndex
CREATE UNIQUE INDEX "project_groups_user_id_system_key_key" ON "project_groups"("user_id", "system_key");

-- CreateIndex
CREATE INDEX "project_group_items_project_id_idx" ON "project_group_items"("project_id");

-- AddForeignKey
ALTER TABLE "project_groups" ADD CONSTRAINT "project_groups_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_group_items" ADD CONSTRAINT "project_group_items_group_id_fkey" FOREIGN KEY ("group_id") REFERENCES "project_groups"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_group_items" ADD CONSTRAINT "project_group_items_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;
