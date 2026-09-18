-- Tab monitor: per-tab state reported by tool hooks, the event log, and the per-machine hook token.
CREATE TYPE "TabState" AS ENUM ('working', 'waiting_input', 'waiting_permission', 'idle', 'error');

ALTER TABLE "tabs" ADD COLUMN "state" "TabState";
ALTER TABLE "tabs" ADD COLUMN "state_text" TEXT;
ALTER TABLE "tabs" ADD COLUMN "state_tool" TEXT;
ALTER TABLE "tabs" ADD COLUMN "state_at" TIMESTAMP(3);

CREATE TABLE "tab_events" (
    "id" TEXT NOT NULL,
    "tab_id" TEXT NOT NULL,
    "kind" "TabState" NOT NULL,
    "tool" TEXT NOT NULL,
    "text" TEXT,
    "meta" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tab_events_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "tab_events_tab_id_created_at_idx" ON "tab_events"("tab_id", "created_at");
ALTER TABLE "tab_events" ADD CONSTRAINT "tab_events_tab_id_fkey" FOREIGN KEY ("tab_id") REFERENCES "tabs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "machine_hooks" (
    "machine_id" TEXT NOT NULL,
    "token_hash" TEXT NOT NULL,
    "installed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "machine_hooks_pkey" PRIMARY KEY ("machine_id")
);
CREATE UNIQUE INDEX "machine_hooks_token_hash_key" ON "machine_hooks"("token_hash");
ALTER TABLE "machine_hooks" ADD CONSTRAINT "machine_hooks_machine_id_fkey" FOREIGN KEY ("machine_id") REFERENCES "machines"("id") ON DELETE CASCADE ON UPDATE CASCADE;
