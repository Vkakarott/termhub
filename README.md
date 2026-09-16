# termhub

Sistema web self-hosted para acessar terminais das suas máquinas na rede local pelo navegador, organizados em **Máquinas > Projetos > Tabs**. Cada tab é uma sessão `tmux` na máquina de destino — fechar o navegador não mata o shell.

- **Backend:** Node.js + Fastify, WebSocket (`ws`), `node-pty`, SQLite (`better-sqlite3`) com repositórios e migrations versionadas
- **Frontend:** React + Vite + xterm.js (fit + webgl), Tailwind
- **Auth:** e-mail/senha (argon2) + Google OAuth (PKCE) + Cloudflare Access (JWT), rate limit com lockout progressivo, CSRF
- **Produção:** Fastify serve o build do frontend na porta 3000, escutando **apenas em 127.0.0.1** (acesso externo via Cloudflare Tunnel)

## Requisitos

- Node.js 20+ (testado com 22)
- `tmux` na máquina onde o termhub roda (para máquinas "local") e em cada máquina SSH
- Para máquinas SSH: chave SSH já configurada (o termhub usa `BatchMode=yes`, sem senha interativa)

## Desenvolvimento

```bash
npm install                # instala server + web (compila node-pty, better-sqlite3, argon2)
cp .env.example .env       # ajuste se precisar (dev funciona com os padrões)
npm run migrate            # cria data/termhub.db
npm run create-user -- --email voce@exemplo.com --name "Seu Nome"   # pede a senha; 1º usuário vira owner
npm run dev                # API em :3000 + Vite em :5173 (proxy de /api e /ws)
```

Abra http://localhost:5173 e faça login. A máquina "local" é criada automaticamente no primeiro boot.

> Se o Vite escolher outra porta (5173 ocupada), use a porta que ele imprimir.

## Build e produção

```bash
npm run build              # web/dist + server/dist
NODE_ENV=production npm start
```

Com `web/dist` presente, o Fastify serve o frontend em `http://127.0.0.1:3000`.

### Serviço de boot

Detecta o SO e instala um serviço de usuário (launchd no macOS, systemd no Linux):

```bash
npm run build
npm run install-service      # cria e inicia o serviço
npm run uninstall-service
```

Logs no macOS: `data/logs/`. No Linux: `journalctl --user -u termhub -f` (use `loginctl enable-linger $USER` para subir sem sessão aberta).

### Cloudflare Tunnel

O servidor só escuta em `127.0.0.1:3000`. Publique com `cloudflared`:

```bash
cloudflared tunnel --url http://127.0.0.1:3000
```

Ajuste `PUBLIC_URL=https://termhub.seudominio.com` no `.env` (cookies `secure` + redirect do Google). Se proteger com **Cloudflare Access**, configure `AUTH_MODE=app,cloudflare`, `CF_TEAM_DOMAIN` e `CF_AUD` — o servidor valida o JWT `Cf-Access-Jwt-Assertion` em toda requisição além da sessão do app.

## Usuários

Não existe cadastro público. Crie usuários pela CLI:

```bash
npm run create-user -- --email voce@exemplo.com --name "Seu Nome" [--password ...] [--role owner|member]
```

- O primeiro usuário vira `owner`.
- **Google:** só entra quem já tem o e-mail cadastrado; na primeira vez o `google_id` é vinculado. Configure `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET` e cadastre `<PUBLIC_URL>/api/auth/google/callback` como redirect URI autorizado no Google Cloud Console.

## Máquinas e projetos

- **Máquina local:** criada automaticamente. Terminais rodam `tmux new-session -A -s <sessão> -c <cwd>` direto.
- **Máquina SSH:** na sidebar, "+ máquina" → tipo SSH, host, usuário e porta. Terminais rodam `ssh -tt ... "tmux new-session -A -s <sessão> -c '<cwd>'"`. Teste antes no servidor do termhub: `ssh -o BatchMode=yes usuario@host exit` deve funcionar sem pedir senha.
- **Projeto:** passe o mouse sobre a máquina e clique em "+". Informe nome e o diretório absoluto na máquina de destino.
- **Tabs:** `⌘T` nova, duplo clique renomeia, `⌘W` fecha (com confirmação — mata a sessão tmux), `⌘1..9` troca. Como alguns navegadores capturam `⌘T`/`⌘W`, `Ctrl+Shift+T`/`Ctrl+Shift+W` funcionam como alternativa.
- Sessões tmux têm o nome `termhub-<project_id>-<tab_id>`; você pode anexar por fora com `tmux attach -t <nome>`.

## Variáveis de ambiente

Veja [.env.example](.env.example). Principais:

| Variável | Descrição |
| --- | --- |
| `AUTH_MODE` | `app`, `cloudflare`, `disabled` (dev) ou combinação `app,cloudflare` |
| `PUBLIC_URL` | URL pública (cookies secure e redirect OAuth) |
| `DATA_DIR` | pasta do SQLite (padrão `./data`) |
| `TMUX_PATH` | caminho do tmux (útil como serviço, PATH mínimo) |
| `LOCAL_SHELL` | shell dentro do tmux local (padrão `$SHELL`) |

## Estrutura

```
server/src
  auth/          provedores (senha, google, cloudflare), sessão, CSRF, middleware
  db/            conexão, migrations versionadas, repositórios (camada de dados isolada)
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
