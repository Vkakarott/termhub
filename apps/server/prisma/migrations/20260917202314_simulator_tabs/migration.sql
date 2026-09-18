-- CreateEnum
CREATE TYPE "TabKind" AS ENUM ('terminal', 'simulator');

-- AlterTable
ALTER TABLE "tabs" ADD COLUMN     "kind" "TabKind" NOT NULL DEFAULT 'terminal',
ADD COLUMN     "simulator_udid" TEXT,
ALTER COLUMN "tmux_session" DROP NOT NULL;
