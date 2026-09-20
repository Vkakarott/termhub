-- Additive and nullable: the previous release keeps serving while this runs.
ALTER TABLE "tabs" ADD COLUMN "created_by_token_id" TEXT;
CREATE INDEX "tabs_created_by_token_id_idx" ON "tabs"("created_by_token_id");
