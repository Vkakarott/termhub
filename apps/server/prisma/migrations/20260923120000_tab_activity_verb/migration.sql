-- The monitor now also keeps Claude Code's spinner verb ("Moonwalking") next to the activity.

-- AlterTable
-- Nullable and additive: the previous release keeps serving unmodified during blue/green. Set and
-- cleared together with "activity"; null = no verb reported.
ALTER TABLE "tabs" ADD COLUMN "activity_verb" TEXT;
