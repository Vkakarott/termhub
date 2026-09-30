-- TER-417: the final message of the agent's last turn, whole, as the hooks deliver it (spec 2026-09-30
-- last answer §2). A table of its own, so no tab query pays for it. New table only: the previous
-- release keeps serving during the deploy and never names it.
CREATE TABLE "tab_last_answers" (
    "tab_id" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "tool" TEXT NOT NULL,
    "at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "tab_last_answers_pkey" PRIMARY KEY ("tab_id")
);
ALTER TABLE "tab_last_answers" ADD CONSTRAINT "tab_last_answers_tab_id_fkey" FOREIGN KEY ("tab_id") REFERENCES "tabs"("id") ON DELETE CASCADE ON UPDATE CASCADE;
