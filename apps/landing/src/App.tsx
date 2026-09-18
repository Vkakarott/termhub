const APP_URL = 'https://app.termhub.dev';
const REPO_URL = 'https://github.com/engenhariainversa/termhub';
const COFFEE_URL = 'https://buymeacoffee.com/pedrogoiania';

const FEATURES: { title: string; text: string; icon: string }[] = [
  {
    icon: '▮_',
    title: 'Terminais que não morrem',
    text: 'Cada tab é uma sessão tmux na máquina de destino. Feche o navegador, troque de computador, volte amanhã: o shell continua onde estava.',
  },
  {
    icon: '⌂',
    title: 'Máquinas › Projetos › Tabs',
    text: 'Cadastre suas máquinas (local ou SSH), organize por projeto com a pasta certa e abra quantas tabs precisar. Um navegador de pastas e discos ajuda a escolher o diretório.',
  },
  {
    icon: '✦',
    title: 'Feito para agentes de IA',
    text: 'Cole imagens e arraste arquivos direto no terminal do Claude Code. Selecione e copie mesmo com o app usando o mouse. Locale UTF-8 garantido em qualquer máquina.',
  },
  {
    icon: '▦',
    title: 'Kanban, notas e tickets',
    text: 'Tarefas por projeto com Backlog › A fazer › Fazendo › Feito, notas em markdown com autosave e sincronização de tickets do Linear, Jira e GitHub.',
  },
  {
    icon: '◔',
    title: 'Limites das suas contas de IA',
    text: 'Veja quanto resta das janelas de uso do Claude, ChatGPT e Gemini, lidas do login dos CLIs nas suas máquinas. Nenhum token é armazenado.',
  },
  {
    icon: '◫',
    title: 'Hardware ao vivo',
    text: 'CPU, memória, discos, temperaturas e processos de cada máquina, atualizados a cada 5 segundos. Simulador iOS na tela, com toque e teclado.',
  },
];

const STEPS: { n: string; title: string; text: string }[] = [
  { n: '1', title: 'Suba com Docker', text: 'docker compose --profile prod up -d. Postgres, e-mail de login e o app. Publique pela LAN ou por um Cloudflare Tunnel.' },
  { n: '2', title: 'Autorize a chave', text: 'O termhub gera uma chave SSH própria. O formulário de máquina mostra o comando pronto para colar e testa a conexão explicando o que faltou.' },
  { n: '3', title: 'Abra um terminal', text: 'Escolha a máquina, a pasta do projeto e pronto. ⌘T abre outra tab, ⌘1..9 alterna. Tudo continua rodando quando você fecha a aba.' },
];

function Logo({ className = 'h-10' }: { className?: string }) {
  return <img src="/logo.svg" alt="termhub — os terminais das suas máquinas, no navegador" className={className} />;
}

function TerminalMock() {
  const lines: { c: string; t: string }[] = [
    { c: 'text-fg-dim', t: '# jarvis › meu-app › tab 1' },
    { c: 'text-accent-2', t: '❯ claude' },
    { c: 'text-fg-muted', t: '✻ Claude Code · /Users/pedro/projetos/meu-app' },
    { c: 'text-fg-dim', t: '' },
    { c: 'text-fg', t: '> corrige o bug do login e abre o PR' },
    { c: 'text-fg-dim', t: '  ~/.cache/termhub/paste/paste-…-screenshot.png' },
    { c: 'text-ok', t: '✓ Read  src/auth/login.ts' },
    { c: 'text-ok', t: '✓ Edit  src/auth/login.ts' },
    { c: 'text-warn', t: '● Bash  npm test' },
  ];
  return (
    <div className="overflow-hidden rounded-lg border border-line bg-bg-2 shadow-2xl">
      <div className="flex items-center gap-2 border-b border-line px-3 py-2">
        <span className="h-2.5 w-2.5 rounded-full bg-danger" />
        <span className="h-2.5 w-2.5 rounded-full bg-warn" />
        <span className="h-2.5 w-2.5 rounded-full bg-ok" />
        <span className="ml-3 flex gap-1 text-[11px]">
          <span className="rounded bg-accent/15 px-2 py-0.5 text-fg">claude</span>
          <span className="rounded px-2 py-0.5 text-fg-dim">server</span>
          <span className="rounded px-2 py-0.5 text-fg-dim">logs</span>
        </span>
        <span className="ml-auto text-[10px] text-fg-dim">tmux · UTF-8</span>
      </div>
      <pre className="overflow-x-auto p-4 font-mono text-[12px] leading-5">
        {lines.map((l, i) => (
          <div key={i} className={l.c}>
            {l.t}
          </div>
        ))}
        <div className="text-fg">
          <span className="inline-block h-4 w-2 animate-pulse bg-fg align-middle" />
        </div>
      </pre>
      <div className="flex items-center gap-2 border-t border-line bg-bg-2 px-3 py-1 text-[11px] text-fg-dim">
        <span className="rounded bg-ok/15 px-1.5 text-ok">Conectado</span>
        <span>app usa o mouse · ⌥ + arrastar seleciona</span>
        <span className="ml-auto font-mono">tmux</span>
      </div>
    </div>
  );
}

export function App() {
  return (
    <div className="min-h-full">
      <header className="sticky top-0 z-10 border-b border-line bg-bg/80 backdrop-blur">
        <div className="mx-auto flex h-14 max-w-6xl items-center gap-4 px-4">
          <a href="#" aria-label="termhub">
            <Logo className="h-8" />
          </a>
          <nav className="ml-auto hidden items-center gap-5 text-sm text-fg-muted sm:flex">
            <a href="#recursos" className="hover:text-fg">
              Recursos
            </a>
            <a href="#como-funciona" className="hover:text-fg">
              Como funciona
            </a>
            <a href={REPO_URL} className="hover:text-fg">
              GitHub
            </a>
          </nav>
          <a href={APP_URL} className="btn-primary ml-2">
            Entrar no app
          </a>
        </div>
      </header>

      <main>
        {/* hero */}
        <section className="mx-auto grid max-w-6xl items-center gap-10 px-4 pb-16 pt-14 md:grid-cols-2 md:pt-20">
          <div>
            <p className="mb-3 inline-flex items-center gap-2 rounded-full border border-line bg-bg-2 px-3 py-1 text-xs text-fg-muted">
              <span className="h-1.5 w-1.5 rounded-full bg-ok" /> self-hosted · open source · MIT
            </p>
            <h1 className="text-4xl font-semibold leading-tight tracking-tight md:text-5xl">
              Os terminais das suas máquinas, <span className="bg-gradient-to-r from-accent to-accent-2 bg-clip-text text-transparent">no navegador</span>.
            </h1>
            <p className="mt-4 max-w-xl text-lg text-fg-muted">
              Máquinas, projetos e tabs. Cada tab é uma sessão tmux que sobrevive ao navegador. Pensado para quem passa o dia em terminais com agentes de IA.
            </p>
            <div className="mt-7 flex flex-wrap gap-3">
              <a href={APP_URL} className="btn-primary">
                Entrar no app →
              </a>
              <a href={REPO_URL} className="btn-ghost">
                Ver no GitHub
              </a>
            </div>
            <p className="mt-5 text-xs text-fg-dim">
              <span className="kbd">⌘T</span> nova tab · <span className="kbd">⌘1..9</span> alterna · <span className="kbd">⌘V</span> cola imagem no Claude
            </p>
          </div>
          <TerminalMock />
        </section>

        {/* features */}
        <section id="recursos" className="border-t border-line bg-bg-2/40">
          <div className="mx-auto max-w-6xl px-4 py-16">
            <h2 className="text-2xl font-semibold tracking-tight">Um lugar para o seu dia de terminal</h2>
            <p className="mt-2 max-w-2xl text-fg-muted">Tudo o que você abre de novo toda manhã, já aberto.</p>
            <ul className="mt-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {FEATURES.map((f) => (
                <li key={f.title} className="rounded-lg border border-line bg-bg-2 p-5">
                  <div className="mb-3 inline-flex h-9 w-9 items-center justify-center rounded-md bg-accent/15 font-mono text-sm text-accent">{f.icon}</div>
                  <h3 className="font-medium">{f.title}</h3>
                  <p className="mt-1.5 text-sm text-fg-muted">{f.text}</p>
                </li>
              ))}
            </ul>
          </div>
        </section>

        {/* how it works */}
        <section id="como-funciona" className="mx-auto max-w-6xl px-4 py-16">
          <h2 className="text-2xl font-semibold tracking-tight">Como funciona</h2>
          <ol className="mt-8 grid gap-4 md:grid-cols-3">
            {STEPS.map((s) => (
              <li key={s.n} className="relative rounded-lg border border-line bg-bg-2 p-5 pt-6">
                <span className="absolute -top-3 left-5 flex h-6 w-6 items-center justify-center rounded-full bg-accent text-xs font-semibold text-white">{s.n}</span>
                <h3 className="font-medium">{s.title}</h3>
                <p className="mt-1.5 text-sm text-fg-muted">{s.text}</p>
              </li>
            ))}
          </ol>
          <div className="mt-8 rounded-lg border border-line bg-bg-2 p-5">
            <p className="mb-2 text-xs uppercase tracking-wide text-fg-dim">Stack</p>
            <p className="text-sm text-fg-muted">
              Node.js + Fastify, WebSocket, node-pty e Postgres no servidor. React, Vite e xterm.js no navegador. Login por código de e-mail, senha ou Google, com
              suporte a Cloudflare Access. O conteúdo dos terminais nunca é logado.
            </p>
          </div>
        </section>

        {/* cta */}
        <section className="border-t border-line">
          <div className="mx-auto flex max-w-6xl flex-col items-start gap-4 px-4 py-14 md:flex-row md:items-center">
            <div>
              <h2 className="text-xl font-semibold tracking-tight">Rode na sua rede hoje</h2>
              <p className="mt-1 text-fg-muted">Um docker compose, um usuário criado pela CLI, e os terminais das suas máquinas no navegador.</p>
            </div>
            <div className="flex gap-3 md:ml-auto">
              <a href={`${REPO_URL}#production-docker`} className="btn-primary">
                Instalar
              </a>
              <a href={APP_URL} className="btn-ghost">
                Entrar no app
              </a>
            </div>
          </div>
        </section>
      </main>

      <footer className="border-t border-line">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-x-6 gap-y-2 px-4 py-6 text-xs text-fg-dim">
          <span>© {new Date().getFullYear()} termhub · MIT</span>
          <a href={REPO_URL} className="hover:text-fg">
            GitHub
          </a>
          <a href={`${REPO_URL}/blob/main/README.md`} className="hover:text-fg">
            Documentação
          </a>
          <a href={COFFEE_URL} className="hover:text-fg">
            ☕ Buy me a coffee
          </a>
          <span className="ml-auto">feito em Goiânia</span>
        </div>
      </footer>
    </div>
  );
}
