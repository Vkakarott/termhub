-- Secrets this instance generates for itself (the public city's id key). Additive: a new table
-- the previous container never reads. Rows are created at boot with an insert-if-absent, so both
-- colors of a blue/green switch converge on the first one written.
CREATE TABLE "instance_secrets" (
    "name" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "instance_secrets_pkey" PRIMARY KEY ("name")
);
