-- The public city: an address per person, a switch per project. Both additive: the previous
-- container neither selects nor writes these columns during the blue/green switch.
ALTER TABLE "users" ADD COLUMN "nickname" TEXT;
CREATE UNIQUE INDEX "users_nickname_key" ON "users"("nickname");

ALTER TABLE "projects" ADD COLUMN "is_public" BOOLEAN NOT NULL DEFAULT false;
