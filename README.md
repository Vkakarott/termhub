# termhub

Sistema web self-hosted para acessar terminais das suas máquinas na rede local pelo navegador, organizados em **Máquinas > Projetos > Tabs**. Cada tab é uma sessão `tmux` na máquina de destino — fechar o navegador não mata o shell.

- **Backend:** Node.js + Fastify, WebSocket (`ws`), `node-pty`, Postgres + Prisma (migrations versionadas) com camada de repositórios isolada
- **Frontend:** React + Vite + xterm.js (fit + webgl), Tailwind
- **Auth:** código por e-mail (OTP), senha (argon2) opcional, Google OAuth (PKCE), Cloudflare Access (JWT); rate limit com lockout progressivo, CSRF
- **Produção:** Docker (Fastify serve o build do frontend na porta 3000); Cloudflare Tunnel ou acesso direto na LAN

## Requisitos

- Docker + Docker Compose (Postgres, Mailpit e, opcionalmente, o app)
- Para rodar o app no host: Node.js 20+ e `tmux`
- Em cada máquina SSH: `tmux` instalado e a chave pública do termhub em `~/.ssh/authorized_keys`

## Desenvolvimento

```bash
npm install                 # server + web (compila node-pty e argon2)
cp .env.example .env        # padrões já apontam para o Postgres/Mailpit do compose
docker compose up -d        # Postgres em localhost:5434 + Mailpit (UI em http://localhost:8025)
npm run prisma:migrate      # aplica migrations (cria novas com: npm run prisma:migrate -- --name <nome>)
npm run create-user -- --email voce@exemplo.com --name "Seu Nome"   # 1º usuário vira owner
npm run dev                 # API em :3000 + Vite em :5173 (proxy de /api e /ws)
```

Abra http://localhost:5173, informe o e-mail e pegue o código de 6 dígitos no Mailpit (http://localhost:8025). A máquina "local" é criada automaticamente no primeiro boot (`SEED_LOCAL_MACHINE=true`).

Tudo dentro do Docker, com hot-reload (`Dockerfile.dev`):

```bash
docker compose --profile dev up --build
```

## Produção (Docker)

```bash
cp .env.example .env        # ajuste: HOST/BIND_ADDR, PUBLIC_URL, POSTGRES_PASSWORD, SMTP_*, ENCRYPTION_KEY
docker compose --profile prod up -d --build
docker compose exec app node server/dist/cli/create-user.js voce@exemplo.com "Seu Nome"
```

### CI/CD (GitHub Actions → jarvis)

`.github/workflows/deploy.yml`: em todo push na `main` (e em PRs) roda o job **check** no GitHub (npm ci, typecheck server/web, build, `prisma migrate deploy` + `migrate diff --exit-code` num Postgres efêmero — garante que as migrations batem com o schema). Se passar e for push na `main`, o job **deploy** roda no **runner self-hosted do jarvis** (`/mnt/hd2tb/github-runner-termhub`, labels `jarvis,termhub`): checkout → `docker compose --env-file /mnt/hd2tb/projetos/termhub/.env --profile prod up -d --build` → espera o healthcheck → `prisma migrate status`.

O `.env` de produção **fica só no servidor** (`/mnt/hd2tb/projetos/termhub/.env`, chmod 600); nenhum segredo passa pelo GitHub. Para mudar uma variável: edite o arquivo lá e rode o workflow de novo (ou `docker compose --env-file ... --profile prod up -d`). O compose tem `name: termhub` fixo, então volumes (`termhub_pgdata`, `termhub_sshkeys`) não dependem do diretório de checkout.

Runner como serviço (uma vez, precisa de sudo): `cd /mnt/hd2tb/github-runner-termhub && sudo ./svc.sh install pedrogoiania && sudo ./svc.sh start`.

O `Dockerfile` gera uma imagem enxuta (tmux + ssh) e o entrypoint roda `prisma migrate deploy` a cada boot. Principais variáveis:

| Variável | Valor |
| --- | --- |
| `BIND_ADDR` | `127.0.0.1` (só Cloudflare Tunnel) ou `0.0.0.0` (acesso direto pelo IP na LAN) |
| `PUBLIC_URL` | `http://192.168.x.x:3000` ou `https://termhub.seudominio.com` |
| `SMTP_HOST` | `mailpit` (caixa local, UI em `:8025`) ou um SMTP real (Mailgun etc.) |
| `SEED_LOCAL_MACHINE` | `false` — no Docker a "local" seria o container |

**Dentro do Docker, o próprio host precisa ser cadastrado como máquina SSH.** O container gera uma chave no primeiro boot (volume `sshkeys`); a pública aparece no formulário de nova máquina e no log (`docker compose logs app | grep chave`). Autorize-a no host e cadastre `host.docker.internal` como host (usuário e porta do SSH do host). Instale `tmux` no host.

### Sem Docker (Node no host)

```bash
npm run build && NODE_ENV=production npm start
```

### Serviço de boot (sem Docker)

Detecta o SO e instala um serviço de usuário (launchd no macOS, systemd no Linux):

```bash
npm run build
npm run install-service      # cria e inicia o serviço
npm run uninstall-service
```

Logs no macOS: `data/logs/`. No Linux: `journalctl --user -u termhub -f` (use `loginctl enable-linger $USER` para subir sem sessão aberta).

### Cloudflare Tunnel

No jarvis o termhub é publicado em **https://termhub.dev** pelo proxy existente (`/mnt/hd2tb/proxy`: nginx + `cloudflared`, túnel "jarvis"). O overlay `docker-compose.proxy.yml` coloca o `app` na rede docker externa `proxy`; o vhost `nginx/conf.d/termhub.dev.conf` faz `proxy_pass http://termhub-app:3000` com upgrade de WebSocket; o hostname público é gerenciado no painel Zero Trust → Tunnels → jarvis (`termhub.dev` → HTTP → `proxy-nginx:80`). O workflow recarrega o nginx após cada deploy (container novo = IP novo). Para rodar o compose à mão no jarvis, exporte `ENV_FILE=/mnt/hd2tb/projetos/termhub/.env` (o `env_file` dos serviços usa essa variável).

Em outro servidor, o caminho simples é `cloudflared tunnel --url http://127.0.0.1:3000`.

Ajuste `PUBLIC_URL=https://termhub.seudominio.com` no `.env` (cookies `secure` + redirect do Google). Se proteger com **Cloudflare Access**, configure `AUTH_MODE=app,cloudflare`, `CF_TEAM_DOMAIN` e `CF_AUD` — o servidor valida o JWT `Cf-Access-Jwt-Assertion` em toda requisição além da sessão do app.

## Usuários e login

Não existe cadastro público. Crie usuários pela CLI:

```bash
npm run create-user -- --email voce@exemplo.com --name "Seu Nome" [--password ...] [--role owner|member]
# Docker: docker compose exec app node server/dist/cli/create-user.js voce@exemplo.com "Seu Nome"
```

- **Código por e-mail (padrão):** informe o e-mail, receba um código de 6 dígitos (expira em `LOGIN_CODE_TTL_MINUTES`, 5 tentativas, máx. 3 envios a cada 10 min). E-mails não cadastrados recebem a mesma resposta, sem envio.
- **Senha:** opcional (`--password`); botão "Entrar com senha" na tela de login.
- O primeiro usuário vira `owner`.
- **Google:** só entra quem já tem o e-mail cadastrado; na primeira vez o `google_id` é vinculado. Configure `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET` e cadastre `<PUBLIC_URL>/api/auth/google/callback` como redirect URI autorizado no Google Cloud Console.

## Máquinas e projetos

- **Máquina local:** criada automaticamente. Terminais rodam `tmux new-session -A -s <sessão> -c <cwd>` direto.
- **Máquina SSH:** na sidebar, "+ máquina" → tipo SSH, host, usuário e porta. Terminais rodam `ssh -tt ... "tmux new-session -A -s <sessão> -c '<cwd>'"`. Teste antes no servidor do termhub: `ssh -o BatchMode=yes usuario@host exit` deve funcionar sem pedir senha.
- **Projeto:** passe o mouse sobre a máquina e clique em "+". Informe nome e o diretório absoluto na máquina de destino — ou clique em "Procurar…" para navegar pelas pastas da máquina: o navegador lista os discos/mounts (com espaço livre, via `df`) e o home como atalhos, permite filtrar e mostrar pastas ocultas, e preenche o nome do projeto com a pasta escolhida (`GET /api/machines/:id/fs?path=`). "+ Nova pasta" cria uma subpasta na pasta atual (`POST /api/machines/:id/fs/mkdir`). Ao salvar, o servidor confere a pasta na máquina e resolve `~` para o caminho absoluto; com "criar a pasta se não existir" marcado, faz `mkdir -p`; desmarcado, recusa com erro em vez de deixar o tmux cair no home.
- **Tabs:** `⌘T` nova, duplo clique renomeia, `⌘W` fecha (com confirmação — mata a sessão tmux), `⌘1..9` troca. Como alguns navegadores capturam `⌘T`/`⌘W`, `Ctrl+Shift+T`/`Ctrl+Shift+W` funcionam como alternativa.
- **Copiar:** selecionar texto copia automaticamente ao soltar o mouse (aviso "Copiado" na barra de status). Quando o programa em execução liga o mouse tracking (Claude Code, vim, htop…), o arrasto vai para ele; segure `⌥` (Mac) ou `Shift` (Linux/Windows) ao arrastar para selecionar — a barra de status avisa quando isso está ativo.
- **Colar imagem:** `Cmd+V` com uma imagem na área de transferência envia o arquivo para `~/.cache/termhub/paste/` na máquina da tab (até 20 MB; PNG, JPEG, GIF ou WebP; arquivos com mais de 7 dias são apagados a cada novo upload) e cola o caminho no terminal — para o Claude Code é como arrastar o arquivo; a barra de status mostra o progresso. Texto continua colando normalmente.
- Sessões tmux têm o nome `termhub-<project_id>-<tab_id>`; você pode anexar por fora com `tmux attach -t <nome>`.

## Gestão dos projetos

Cada projeto tem navegação interna: **Terminais | Tarefas | Notas | Configurações**.

- **Tarefas:** kanban com quatro colunas (Backlog / A fazer / Fazendo / Feito), arrastar e soltar entre colunas e para reordenar, criação rápida no topo de cada coluna (Enter), duplo clique renomeia, clique abre título/descrição/status/excluir. O contador de tasks abertas aparece na sidebar ao lado do projeto. O campo `external_ref` (JSON) fica reservado para integrações futuras (GitHub/Jira/Linear).
- **Notas:** uma nota em markdown por projeto, com preview (GFM), modos editar / lado a lado / preview e autosave com debounce (⌘S força).
- **Dashboard** (home): projetos ativos com máquina (online/offline), tasks em "Fazendo", total de abertas e último acesso a terminal — ordenado pelo terminal mais recente.
- **Configurações:** renomear, editar `cwd`, descrição, status (ativo/pausado/arquivado) e excluir (encerra as sessões tmux das tabs). Na sidebar, passar o mouse sobre um projeto mostra ✎ (abre as Configurações) e ✕ (remove o projeto da lista — a pasta na máquina não é tocada).

## Integrações e Setup do projeto

- **Integrações** (sidebar → ⚙ Integrações): credenciais de **GitHub** (token), **Linear** (API key) e **Jira** (URL + e-mail + API token). Segredos criptografados com `ENCRYPTION_KEY` (AES-256-GCM); botão "Testar" valida e lista times/projetos/repos.
- **Setup** (aba do projeto): repositório (integração GitHub, `owner/repo`, branch base, padrão de branch, PR draft), **tickets** (fonte Linear/Jira/GitHub + escopo + filtro + sync automático), **runner** (máquina onde a automação roda, cwd, comando de preparação, worktree), **agente** (comando, plugins, modelo), **verificação** (screenshot iOS/web/comando) e **aprovações** (cada decisão: pedir no dashboard ou automático).
- **Tickets** (aba do projeto): o sync (`POST /api/projects/:id/tickets/sync` ou automático) alimenta uma **lista de tickets por integração** — nada entra no board sozinho. Você seleciona os que quer e clica em "Enviar para o backlog": viram tasks na coluna **Backlog** com `external_ref` (`{provider, id, identifier, url, state}`). Syncs seguintes só atualizam o espelho do estado externo; a coluna e o título no kanban são seus. Excluir a task devolve o ticket à lista.
- **Nada volta para Linear/Jira/GitHub automaticamente**: na task (⋯) o botão "Atualizar no Linear/Jira" empurra a coluna atual para o provedor (Linear: estado do tipo correspondente no time; Jira: transição pela `statusCategory`; GitHub: open/closed). O card avisa quando o estado externo difere da coluna.
- **Terminal por task**: "Abrir terminal para esta task" cria uma tab tmux com o nome do ticket e a vincula (`tasks.tab_id`); o card mostra `▮_` com link direto para a tab. É onde a run do agente vai aparecer.
- O status das máquinas detecta SO e ferramentas (`claude`, `gh`, `git`, `node`, `xcodebuild`, `adb`…) — usado para escolher o runner.

## Variáveis de ambiente

Veja [.env.example](.env.example). Principais:

| Variável | Descrição |
| --- | --- |
| `AUTH_MODE` | `app`, `cloudflare`, `disabled` (dev) ou combinação `app,cloudflare` |
| `PUBLIC_URL` | URL pública (cookies secure e redirect OAuth) |
| `DATABASE_URL` | Postgres (`postgresql://user:pass@host:5432/db`) |
| `SMTP_HOST`/`SMTP_PORT`/`SMTP_USER`/`SMTP_PASS`/`EMAIL_FROM` | envio do código de login |
| `BIND_ADDR` | (compose) IP do host onde publicar as portas |
| `ENCRYPTION_KEY` | base64 de 32 bytes (`openssl rand -base64 32`) para os segredos das integrações |
| `TMUX_PATH` | caminho do tmux (útil como serviço, PATH mínimo) |
| `LOCAL_SHELL` | shell dentro do tmux local (padrão `$SHELL`) |

## Estrutura

```
server/prisma      schema.prisma + migrations (npm run prisma:migrate -- --name <nome>)
server/src
  auth/          provedores (senha, google, cloudflare), sessão, CSRF, middleware
  db/            Prisma client + repositórios (o resto do app nunca importa o Prisma)
  email/         mailer (SMTP/console) e templates
  cli/           create-user
  routes/        rotas REST (zod em todas as entradas)
  terminal/      exec em máquinas (local/ssh), PTY, WebSocket
web/src
  components/    Sidebar, TabBar, Terminal (xterm), formulários
  pages/         Login, Home, Projeto
  lib/           api client, auth/data providers, conexão WS com backoff
```

## Segurança

- Cookies `httpOnly` + `SameSite=Lax`; token de sessão opaco, só o hash vai pro banco
- CSRF double-submit (`termhub_csrf` + header `x-csrf-token`) em todas as mutações
- Lockout progressivo no login (por e-mail e por IP)
- WebSocket: autenticação no upgrade + verificação de `Origin`
- Conteúdo dos terminais nunca é logado
