-- Projects become user-owned and linked to machines through project_machines; tabs know their machine.
-- Not backward compatible with the previous release (accepted, spec §11).

-- 1. New columns and table (nullable first so the backfill can run)
ALTER TABLE "projects" ADD COLUMN "owner_id" TEXT,
                       ADD COLUMN "key" TEXT,
                       ADD COLUMN "next_task_number" INTEGER NOT NULL DEFAULT 1;

CREATE TABLE "project_machines" (
    "id" TEXT NOT NULL,
    "project_id" TEXT NOT NULL,
    "machine_id" TEXT NOT NULL,
    "cwd" TEXT NOT NULL,
    "position" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "project_machines_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "tabs" ADD COLUMN "machine_id" TEXT;

-- 2. Backfill from the old machine_id / cwd
UPDATE "projects" p SET "owner_id" = m."owner_id" FROM "machines" m WHERE m."id" = p."machine_id";

INSERT INTO "project_machines" ("id", "project_id", "machine_id", "cwd", "position")
SELECT 'pm' || p."id", p."id", p."machine_id", p."cwd", 0 FROM "projects" p;

UPDATE "tabs" t SET "machine_id" = p."machine_id" FROM "projects" p WHERE p."id" = t."project_id";

-- Keys: initials of the name's words (letters/digits), else its first 3 letters, uppercased,
-- prefixed with P when it would start with a digit, suffixed with 2, 3, … on collision.
DO $$
DECLARE
  r RECORD;
  base TEXT;
  candidate TEXT;
  n INT;
BEGIN
  FOR r IN SELECT "id", "name" FROM "projects" ORDER BY "created_at", "id" LOOP
    SELECT string_agg(upper(left(w, 1)), '') INTO base
      FROM regexp_split_to_table(regexp_replace(r."name", '[^A-Za-z0-9 ]', ' ', 'g'), '\s+') AS w
     WHERE w <> '';
    IF base IS NULL OR length(base) < 2 THEN
      base := upper(left(regexp_replace(r."name", '[^A-Za-z0-9]', '', 'g'), 3));
    END IF;
    IF base IS NULL OR length(base) < 2 THEN
      base := 'PRJ';
    END IF;
    base := left(base, 10);
    IF base !~ '^[A-Z]' THEN
      base := 'P' || left(base, 9);
    END IF;
    candidate := base;
    n := 1;
    WHILE EXISTS (SELECT 1 FROM "projects" WHERE "key" = candidate) LOOP
      n := n + 1;
      candidate := left(base, 10 - length(n::text)) || n::text;
    END LOOP;
    UPDATE "projects" SET "key" = candidate WHERE "id" = r."id";
  END LOOP;
END $$;

-- 3. Constraints
ALTER TABLE "tabs" ALTER COLUMN "machine_id" SET NOT NULL;
ALTER TABLE "projects" ALTER COLUMN "key" SET NOT NULL;

CREATE UNIQUE INDEX "projects_key_key" ON "projects"("key");
CREATE INDEX "projects_owner_id_idx" ON "projects"("owner_id");
CREATE UNIQUE INDEX "project_machines_project_id_machine_id_key" ON "project_machines"("project_id", "machine_id");
CREATE INDEX "project_machines_machine_id_idx" ON "project_machines"("machine_id");
CREATE INDEX "tabs_machine_id_idx" ON "tabs"("machine_id");

ALTER TABLE "projects" ADD CONSTRAINT "projects_owner_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "project_machines" ADD CONSTRAINT "project_machines_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "project_machines" ADD CONSTRAINT "project_machines_machine_id_fkey" FOREIGN KEY ("machine_id") REFERENCES "machines"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "tabs" ADD CONSTRAINT "tabs_machine_id_fkey" FOREIGN KEY ("machine_id") REFERENCES "machines"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- 4. Drop the old columns
ALTER TABLE "projects" DROP CONSTRAINT "projects_machine_id_fkey";
DROP INDEX "projects_machine_id_idx";
ALTER TABLE "projects" DROP COLUMN "machine_id", DROP COLUMN "cwd";
