-- AlterTable
ALTER TABLE "users" ADD COLUMN     "role_id" TEXT;

-- CreateTable
CREATE TABLE "roles" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "description" TEXT,
    "is_system" BOOLEAN NOT NULL DEFAULT false,
    "is_admin" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "roles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "permissions" (
    "id" TEXT NOT NULL,
    "resource" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "role_id" TEXT NOT NULL,

    CONSTRAINT "permissions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "roles_name_key" ON "roles"("name");

-- CreateIndex
CREATE UNIQUE INDEX "permissions_resource_action_role_id_key" ON "permissions"("resource", "action", "role_id");

-- CreateIndex
CREATE INDEX "users_role_id_idx" ON "users"("role_id");

-- AddForeignKey
ALTER TABLE "users" ADD CONSTRAINT "users_role_id_fkey" FOREIGN KEY ("role_id") REFERENCES "roles"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "permissions" ADD CONSTRAINT "permissions_role_id_fkey" FOREIGN KEY ("role_id") REFERENCES "roles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ── System roles (fixed ids, see SYSTEM_ROLE_IDS) ────────────────────────────
INSERT INTO "roles" ("id", "name", "label", "description", "is_system", "is_admin", "created_at", "updated_at") VALUES
  ('role_admin',         'ADMIN',         'Administrador', 'Acesso total ao sistema. Não pode ser removida.',                     true, true,  now(), now()),
  ('role_manager',       'MANAGER',       'Gerente',       'Opera máquinas, projetos e integrações; vê usuários e painéis.',      true, false, now(), now()),
  ('role_authenticated', 'AUTHENTICATED', 'Autenticado',   'Usuário padrão: máquinas, projetos, terminais, tarefas e notas.',    true, false, now(), now())
ON CONFLICT ("name") DO NOTHING;

-- ── Default grants ────────────────────────────────────────────────────────────
-- AUTHENTICATED: the day-to-day workspace, full CRUD (matches what every member could do before roles).
INSERT INTO "permissions" ("id", "resource", "action", "role_id")
SELECT 'perm_auth_' || r || '_' || a, r, a, 'role_authenticated'
FROM unnest(ARRAY['machines','projects','terminals','tasks','notes','tickets','integrations']) AS r,
     unnest(ARRAY['create','read','update','delete']) AS a
ON CONFLICT DO NOTHING;
-- MANAGER: everything AUTHENTICATED has, plus the dashboards and read-only users.
INSERT INTO "permissions" ("id", "resource", "action", "role_id")
SELECT 'perm_mgr_' || r || '_' || a, r, a, 'role_manager'
FROM unnest(ARRAY['machines','projects','terminals','tasks','notes','tickets','integrations','ai_accounts','hardware','waitlist']) AS r,
     unnest(ARRAY['create','read','update','delete']) AS a
ON CONFLICT DO NOTHING;
INSERT INTO "permissions" ("id", "resource", "action", "role_id") VALUES ('perm_mgr_users_read', 'users', 'read', 'role_manager') ON CONFLICT DO NOTHING;

-- ── Backfill existing users from the legacy enum ──────────────────────────────
UPDATE "users" SET "role_id" = CASE WHEN "role" = 'owner' THEN 'role_admin' ELSE 'role_authenticated' END WHERE "role_id" IS NULL;
