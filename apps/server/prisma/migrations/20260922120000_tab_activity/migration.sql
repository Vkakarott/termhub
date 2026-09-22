-- The monitor now reads what a working agent is doing from the tool it is about to call.

-- CreateEnum
CREATE TYPE "TabActivity" AS ENUM ('coding', 'reading', 'researching', 'planning', 'terminal', 'working');

-- AlterTable
-- Nullable and additive: the previous release keeps serving unmodified during blue/green. Set while
-- the tab is working, cleared when it leaves that state; null = not working or never reported.
ALTER TABLE "tabs" ADD COLUMN "activity" "TabActivity";
