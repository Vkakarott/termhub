-- Additive: new tables and two nullable columns the previous container never reads.
-- AlterTable
ALTER TABLE "users" ADD COLUMN "review_enabled_until" TIMESTAMP(3), ADD COLUMN "review_enabled_by" TEXT;

-- CreateTable
CREATE TABLE "device_requests" (
    "id" TEXT NOT NULL,
    "user_id" TEXT,
    "email_hash" TEXT NOT NULL,
    "public_key" TEXT NOT NULL,
    "key_thumbprint" TEXT NOT NULL,
    "platform" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "os_version" TEXT NOT NULL,
    "device_name" TEXT NOT NULL,
    "app_version" TEXT NOT NULL,
    "verification_code" TEXT NOT NULL,
    "request_secret_hash" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "ip" TEXT NOT NULL,
    "country" TEXT,
    "city" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "decided_at" TIMESTAMP(3),
    "activate_until" TIMESTAMP(3),

    CONSTRAINT "device_requests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "devices" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "platform" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "os_version" TEXT NOT NULL,
    "app_version" TEXT NOT NULL,
    "public_key" TEXT NOT NULL,
    "key_thumbprint" TEXT NOT NULL,
    "pin_secret_enc" TEXT NOT NULL,
    "pin_failures" INTEGER NOT NULL DEFAULT 0,
    "pin_locked_until" TIMESTAMP(3),
    "status" TEXT NOT NULL DEFAULT 'active',
    "revoked_at" TIMESTAMP(3),
    "revoked_reason" TEXT,
    "push_token" TEXT,
    "last_seen_at" TIMESTAMP(3),
    "last_ip" TEXT,
    "request_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "devices_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "device_tokens" (
    "id" TEXT NOT NULL,
    "device_id" TEXT NOT NULL,
    "token_hash" TEXT NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_used_at" TIMESTAMP(3),

    CONSTRAINT "device_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "device_challenges" (
    "id" TEXT NOT NULL,
    "device_id" TEXT NOT NULL,
    "challenge_hash" TEXT NOT NULL,
    "purpose" TEXT NOT NULL,
    "action_id" TEXT,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "used_at" TIMESTAMP(3),

    CONSTRAINT "device_challenges_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "device_events" (
    "id" TEXT NOT NULL,
    "user_id" TEXT,
    "device_id" TEXT,
    "request_id" TEXT,
    "kind" TEXT NOT NULL,
    "actor" TEXT NOT NULL,
    "ip" TEXT,
    "country" TEXT,
    "city" TEXT,
    "meta" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "device_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_notifications" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "data" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "read_at" TIMESTAMP(3),

    CONSTRAINT "user_notifications_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "device_requests_request_secret_hash_key" ON "device_requests"("request_secret_hash");

-- CreateIndex
CREATE INDEX "device_requests_user_id_status_idx" ON "device_requests"("user_id", "status");

-- CreateIndex
CREATE INDEX "device_requests_email_hash_created_at_idx" ON "device_requests"("email_hash", "created_at");

-- CreateIndex
CREATE INDEX "device_requests_expires_at_idx" ON "device_requests"("expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "devices_key_thumbprint_key" ON "devices"("key_thumbprint");

-- CreateIndex
CREATE UNIQUE INDEX "devices_request_id_key" ON "devices"("request_id");

-- CreateIndex
CREATE INDEX "devices_user_id_status_idx" ON "devices"("user_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "device_tokens_token_hash_key" ON "device_tokens"("token_hash");

-- CreateIndex
CREATE INDEX "device_tokens_device_id_idx" ON "device_tokens"("device_id");

-- CreateIndex
CREATE INDEX "device_tokens_expires_at_idx" ON "device_tokens"("expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "device_challenges_challenge_hash_key" ON "device_challenges"("challenge_hash");

-- CreateIndex
CREATE INDEX "device_challenges_expires_at_idx" ON "device_challenges"("expires_at");

-- CreateIndex
CREATE INDEX "device_events_user_id_created_at_idx" ON "device_events"("user_id", "created_at");

-- CreateIndex
CREATE INDEX "device_events_created_at_idx" ON "device_events"("created_at");

-- CreateIndex
CREATE INDEX "user_notifications_user_id_created_at_idx" ON "user_notifications"("user_id", "created_at");

-- CreateIndex
CREATE INDEX "user_notifications_created_at_idx" ON "user_notifications"("created_at");

-- AddForeignKey
ALTER TABLE "device_requests" ADD CONSTRAINT "device_requests_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "devices" ADD CONSTRAINT "devices_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "devices" ADD CONSTRAINT "devices_request_id_fkey" FOREIGN KEY ("request_id") REFERENCES "device_requests"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "device_tokens" ADD CONSTRAINT "device_tokens_device_id_fkey" FOREIGN KEY ("device_id") REFERENCES "devices"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "device_challenges" ADD CONSTRAINT "device_challenges_device_id_fkey" FOREIGN KEY ("device_id") REFERENCES "devices"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_notifications" ADD CONSTRAINT "user_notifications_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- `devices` follows the chat feature flag: granted to every role that holds chat:read today
-- (BETA — see 20260921233000_chat_beta_role); admins bypass the matrix.
INSERT INTO "permissions" ("id", "resource", "action", "role_id")
SELECT 'perm_' || r."id" || '_devices_' || a, 'devices', a, r."id"
FROM "roles" r
JOIN "permissions" p ON p."role_id" = r."id" AND p."resource" = 'chat' AND p."action" = 'read',
     unnest(ARRAY['create','read','update','delete']) AS a
ON CONFLICT DO NOTHING;
