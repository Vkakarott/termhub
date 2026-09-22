-- O chat saiu do passo 1 concedido a AUTHENTICATED e MANAGER (migration
-- 20260921090000_chat_conversations). O combinado era o contrário: o chat conversa com um agente
-- que abre abas, digita e roda comandos nas máquinas do dono da conta, e o gate de permissão cobre
-- só as escritas — a leitura de telas, projetos e tarefas não pede confirmação. Então ele volta a
-- ser fechado, e passa a ser liberado por um role próprio.

-- BETA nasce como cópia exata de AUTHENTICATED: um usuário tem um role só, então um BETA que
-- tivesse apenas 'chat' tiraria máquinas, projetos e terminais de quem fosse movido para ele.
INSERT INTO "roles" ("id", "name", "label", "description", "is_system", "is_admin", "created_at", "updated_at")
SELECT 'role_beta', 'BETA', 'Beta', 'Mesmo acesso do Autenticado, mais os recursos em teste (hoje: o Chat).', false, false, now(), now()
WHERE NOT EXISTS (SELECT 1 FROM "roles" WHERE "name" = 'BETA');

INSERT INTO "permissions" ("id", "resource", "action", "role_id")
SELECT 'perm_beta_' || p."resource" || '_' || p."action", p."resource", p."action", (SELECT "id" FROM "roles" WHERE "name" = 'BETA')
FROM "permissions" p
JOIN "roles" r ON r."id" = p."role_id"
WHERE r."name" = 'AUTHENTICATED'
ON CONFLICT DO NOTHING;

-- o chat é o recurso em teste: BETA tem, mesmo que AUTHENTICATED não tenha mais (abaixo)
INSERT INTO "permissions" ("id", "resource", "action", "role_id")
SELECT 'perm_beta_chat_' || a, 'chat', a, (SELECT "id" FROM "roles" WHERE "name" = 'BETA')
FROM unnest(ARRAY['create','read','update','delete']) AS a
ON CONFLICT DO NOTHING;

-- e só então o chat sai dos roles que todo mundo tem
DELETE FROM "permissions" p
USING "roles" r
WHERE p."role_id" = r."id" AND p."resource" = 'chat' AND r."name" IN ('AUTHENTICATED', 'MANAGER');
