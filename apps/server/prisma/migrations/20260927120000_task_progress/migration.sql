-- Progress panel (spec 2026-09-26 progress-panel §4.1): when a card or subtask started and
-- finished, and how long an agent actually worked on a card. Nullable/defaulted: the previous
-- release keeps writing tasks during a blue/green switch, and the trigger stamps its writes too.
ALTER TABLE "tasks" ADD COLUMN "started_at" TIMESTAMP(3),
  ADD COLUMN "done_at" TIMESTAMP(3),
  ADD COLUMN "active_seconds" INTEGER NOT NULL DEFAULT 0;

-- Best effort for rows that are already done: their last write is when they finished.
UPDATE "tasks" SET "done_at" = "updated_at" WHERE "status" = 'done';

CREATE FUNCTION "tasks_track_progress_times"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."status" = 'doing' AND NEW."started_at" IS NULL THEN
    NEW."started_at" := now();
  END IF;
  IF NEW."status" = 'done' THEN
    IF TG_OP = 'INSERT' THEN
      NEW."done_at" := now();
    ELSIF OLD."status" <> 'done' THEN
      NEW."done_at" := now();
    END IF;
  ELSE
    NEW."done_at" := NULL;
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER "tasks_track_progress_times" BEFORE INSERT OR UPDATE OF "status" ON "tasks"
  FOR EACH ROW EXECUTE FUNCTION "tasks_track_progress_times"();

CREATE INDEX "tasks_tab_id_idx" ON "tasks"("tab_id");
