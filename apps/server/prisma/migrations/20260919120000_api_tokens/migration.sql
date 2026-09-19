-- CreateTable
CREATE TABLE "api_tokens" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "token_hash" TEXT NOT NULL,
    "scopes" TEXT[],
    "expires_at" TIMESTAMP(3),
    "last_used_at" TIMESTAMP(3),
    "revoked_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "api_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "api_token_events" (
    "id" TEXT NOT NULL,
    "token_id" TEXT NOT NULL,
    "tool" TEXT NOT NULL,
    "machine_id" TEXT,
    "project_id" TEXT,
    "tab_id" TEXT,
    "ok" BOOLEAN NOT NULL,
    "error_code" TEXT,
    "duration_ms" INTEGER NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "api_token_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "api_tokens_token_hash_key" ON "api_tokens"("token_hash");

-- CreateIndex
CREATE INDEX "api_tokens_user_id_idx" ON "api_tokens"("user_id");

-- CreateIndex
CREATE INDEX "api_token_events_token_id_created_at_idx" ON "api_token_events"("token_id", "created_at");

-- CreateIndex
CREATE INDEX "api_token_events_created_at_idx" ON "api_token_events"("created_at");

-- AddForeignKey
ALTER TABLE "api_tokens" ADD CONSTRAINT "api_tokens_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "api_token_events" ADD CONSTRAINT "api_token_events_token_id_fkey" FOREIGN KEY ("token_id") REFERENCES "api_tokens"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ── Default grants for the new resource (admins bypass the matrix) ─────────────
INSERT INTO "permissions" ("id", "resource", "action", "role_id")
SELECT 'perm_' || r.prefix || '_api_tokens_' || a, 'api_tokens', a, r.role_id
FROM (VALUES ('auth', 'role_authenticated'), ('mgr', 'role_manager')) AS r(prefix, role_id),
     unnest(ARRAY['create','read','update','delete']) AS a
WHERE EXISTS (SELECT 1 FROM "roles" WHERE "id" = r.role_id)
ON CONFLICT DO NOTHING;
