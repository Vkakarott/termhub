-- Uploads: attribution of files pasted/dropped on a terminal (the file itself lives on the machine).
CREATE TABLE "uploads" (
    "id" TEXT NOT NULL,
    "user_id" TEXT,
    "machine_id" TEXT NOT NULL,
    "project_id" TEXT,
    "tab_id" TEXT,
    "name" TEXT NOT NULL,
    "path" TEXT NOT NULL,
    "mime" TEXT NOT NULL,
    "bytes" INTEGER NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "uploads_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "uploads_machine_id_name_key" ON "uploads"("machine_id", "name");
CREATE INDEX "uploads_user_id_idx" ON "uploads"("user_id");

ALTER TABLE "uploads" ADD CONSTRAINT "uploads_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "uploads" ADD CONSTRAINT "uploads_machine_id_fkey" FOREIGN KEY ("machine_id") REFERENCES "machines"("id") ON DELETE CASCADE ON UPDATE CASCADE;
