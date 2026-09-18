-- Ownership: machines and integrations belong to a user; everything under a machine inherits.
ALTER TABLE "machines" ADD COLUMN "owner_id" TEXT;
ALTER TABLE "integrations" ADD COLUMN "owner_id" TEXT;

CREATE INDEX "machines_owner_id_idx" ON "machines"("owner_id");
CREATE INDEX "integrations_owner_id_idx" ON "integrations"("owner_id");

ALTER TABLE "machines" ADD CONSTRAINT "machines_owner_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "integrations" ADD CONSTRAINT "integrations_owner_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Backfill: everything that exists today belongs to the first admin (the workspace was single-user).
UPDATE "machines" SET "owner_id" = (
  SELECT u."id" FROM "users" u JOIN "roles" r ON r."id" = u."role_id" WHERE r."is_admin" ORDER BY u."created_at" ASC LIMIT 1
) WHERE "owner_id" IS NULL;
UPDATE "integrations" SET "owner_id" = (
  SELECT u."id" FROM "users" u JOIN "roles" r ON r."id" = u."role_id" WHERE r."is_admin" ORDER BY u."created_at" ASC LIMIT 1
) WHERE "owner_id" IS NULL;
