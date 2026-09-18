import { createContext, useContext } from 'react';

export type Lang = 'pt' | 'en';
export const LANG_KEY = 'termhub:lang';

export function detectLang(): Lang {
  // ?lang=pt|en wins (shareable links), then the saved choice, then the browser language
  const q = new URLSearchParams(window.location.search).get('lang');
  if (q === 'pt' || q === 'en') return q;
  try {
    const saved = localStorage.getItem(LANG_KEY);
    if (saved === 'pt' || saved === 'en') return saved;
  } catch {
    /* ignore */
  }
  return /^pt\b/i.test(navigator.language) ? 'pt' : 'en';
}

const pt = {
  meta: { title: 'termhub — os terminais das suas máquinas, no navegador' },
  nav: { features: 'Recursos', how: 'Como funciona', cloud: 'Cloud', github: 'GitHub', app: 'Entrar no app' },
  hero: {
    badge: 'self-hosted · open source · MIT',
    title_a: 'Os terminais das suas máquinas, ',
    title_b: 'no navegador',
    lead: 'Cada tab é uma sessão tmux. Sobrevive ao navegador e à troca de computador. Self-hosted, MIT.',
    cta: 'Entrar no app',
    repo: 'Ver no GitHub',
    keys: { tab: 'nova tab', switch: 'alterna', paste: 'cola imagem no Claude' },
  },
  mock: { prompt: 'corrige o bug do login e abre o PR', status: 'Conectado', hint: 'app usa o mouse · ⌥ + arrastar seleciona' },
  carousel: {
    label: 'O que você vê no termhub',
    tabs: ['Terminal', 'Hardware', 'Simulador iOS', 'Kanban'],
    hardware: {
      caption: 'jarvis · atualizado a cada 5 s',
      kpis: [
        { label: 'CPU', value: '23%', pct: 23 },
        { label: 'Memória', value: '11,2 / 32 GB', pct: 35 },
        { label: 'Disco', value: '412 GB livres', pct: 58 },
        { label: 'Temp', value: '46 °C', pct: 46 },
      ],
      procs_head: ['processo', 'cpu', 'mem'],
      procs: [
        { name: 'node server.js', cpu: '12,4%', mem: '820 MB' },
        { name: 'claude', cpu: '6,1%', mem: '540 MB' },
        { name: 'postgres', cpu: '3,8%', mem: '310 MB' },
        { name: 'tmux: server', cpu: '1,2%', mem: '48 MB' },
        { name: 'sshd', cpu: '0,4%', mem: '12 MB' },
      ],
    },
    ios: {
      screen_title: 'Ajustes',
      rows: ['Rede', 'Notificações', 'Privacidade'],
      button: 'Continuar',
      actions: ['Toque e gestos', 'Teclado', 'Home · Bloquear · Volume', 'Screenshot'],
      caption: 'iPhone 16e · WDA · 25 fps na LAN',
    },
    kanban: {
      columns: [
        { title: 'Backlog', cards: [{ text: 'Retry de SSH', chip: '' }, { text: 'Exportar notas', chip: '' }] },
        { title: 'A fazer', cards: [{ text: 'Sync de tickets', chip: 'LIN-42' }, { text: 'Atalhos de tab', chip: '' }] },
        { title: 'Fazendo', cards: [{ text: 'Simulador iOS', chip: '' }] },
        { title: 'Feito', cards: [{ text: 'Colar imagem', chip: '' }, { text: 'Kanban por projeto', chip: '' }, { text: 'Login por e-mail', chip: '' }] },
      ],
    },
  },
  numbers: [
    { value: '1', label: 'docker compose para subir tudo' },
    { value: '3', label: 'passos até o primeiro terminal' },
    { value: '0', label: 'tokens de IA armazenados' },
  ],
  features: {
    link: 'Ver recursos',
    title: 'Um lugar para o seu dia de terminal',
    lead: 'Tudo o que você abre de novo toda manhã, já aberto.',
    items: [
      { title: 'Terminais que não morrem', text: 'Cada tab é uma sessão tmux na máquina de destino. Feche o navegador, troque de computador, volte amanhã: o shell continua onde estava.' },
      { title: 'Máquinas › Projetos › Tabs', text: 'Cadastre suas máquinas (local ou SSH), organize por projeto com a pasta certa e abra quantas tabs precisar. Um navegador de pastas e discos ajuda a escolher o diretório.' },
      { title: 'Feito para agentes de IA', text: 'Cole imagens e arraste arquivos direto no terminal do Claude Code. Selecione e copie mesmo com o app usando o mouse. Locale UTF-8 garantido em qualquer máquina.' },
      { title: 'Kanban, notas e tickets', text: 'Tarefas por projeto com Backlog › A fazer › Fazendo › Feito, notas em markdown com autosave e sincronização de tickets do Linear, Jira e GitHub.' },
      { title: 'Limites das suas contas de IA', text: 'Veja quanto resta das janelas de uso do Claude, ChatGPT e Gemini, lidas do login dos CLIs nas suas máquinas. Nenhum token é armazenado.' },
      { title: 'Hardware ao vivo', text: 'CPU, memória, discos, temperaturas e processos de cada máquina, atualizados a cada 5 segundos. Simulador iOS na tela, com toque e teclado.' },
    ],
  },
  how: {
    link: 'Ver como instalar',
    title: 'Como funciona',
    steps: [
      { title: 'Suba com Docker', text: 'docker compose --profile prod up -d. Postgres, e-mail de login e o app. Publique pela LAN ou por um Cloudflare Tunnel.' },
      { title: 'Autorize a chave', text: 'O termhub gera uma chave SSH própria. O formulário de máquina mostra o comando pronto para colar e testa a conexão explicando o que faltou.' },
      { title: 'Abra um terminal', text: 'Escolha a máquina, a pasta do projeto e pronto. ⌘T abre outra tab, ⌘1..9 alterna. Tudo continua rodando quando você fecha a aba.' },
    ],
    stack_label: 'Stack',
    stack: 'Node.js + Fastify, WebSocket, node-pty e Postgres no servidor. React, Vite e xterm.js no navegador. Login por código de e-mail, senha ou Google, com suporte a Cloudflare Access. O conteúdo dos terminais nunca é logado.',
  },
  cloud: {
    badge: 'em breve',
    title: 'termhub Cloud',
    lead: 'A mesma experiência, sem servidor para manter: suas máquinas conectam ao termhub Cloud e você acessa de qualquer lugar. Está em lista de espera; inscreva-se para receber o convite.',
    perks: ['Sem Docker, sem proxy, sem túnel: conecte a máquina e pronto', 'Login e allowlist prontos, com times e permissões', 'Convites em ordem de inscrição'],
    form: {
      title: 'Entrar na lista de espera',
      first: 'Nome',
      last: 'Sobrenome',
      email: 'E-mail',
      phone: 'Telefone',
      ddi: 'DDI',
      ddd: 'DDD',
      number: 'número',
      linkedin: 'LinkedIn (opcional)',
      github: 'GitHub (opcional)',
      handle_hint: 'usuário ou URL do perfil',
      submit: 'Quero o convite',
      sending: 'Enviando…',
      done_title: 'Inscrição recebida!',
      done_text: 'Você está na lista. Avisamos por e-mail quando o convite sair.',
      already: 'Este e-mail já está na lista de espera.',
      error: 'Não foi possível enviar agora. Tente de novo em instantes.',
      privacy: 'Usamos seus dados só para o convite do termhub Cloud.',
    },
  },
  cta: { title: 'Rode na sua rede hoje', lead: 'Um docker compose, um usuário criado pela CLI, e os terminais das suas máquinas no navegador.', install: 'Instalar', app: 'Entrar no app' },
  footer: { docs: 'Documentação', coffee: '☕ Buy me a coffee', made: 'feito em Goiânia' },
};

const en: typeof pt = {
  meta: { title: 'termhub — your machines’ terminals, in the browser' },
  nav: { features: 'Features', how: 'How it works', cloud: 'Cloud', github: 'GitHub', app: 'Open the app' },
  hero: {
    badge: 'self-hosted · open source · MIT',
    title_a: 'Your machines’ terminals, ',
    title_b: 'in the browser',
    lead: 'Every tab is a tmux session. It survives the browser and switching computers. Self-hosted, MIT.',
    cta: 'Open the app',
    repo: 'View on GitHub',
    keys: { tab: 'new tab', switch: 'switch', paste: 'paste an image into Claude' },
  },
  mock: { prompt: 'fix the login bug and open the PR', status: 'Connected', hint: 'app owns the mouse · ⌥ + drag selects' },
  carousel: {
    label: 'What you see in termhub',
    tabs: ['Terminal', 'Hardware', 'iOS Simulator', 'Kanban'],
    hardware: {
      caption: 'jarvis · refreshed every 5 s',
      kpis: [
        { label: 'CPU', value: '23%', pct: 23 },
        { label: 'Memory', value: '11.2 / 32 GB', pct: 35 },
        { label: 'Disk', value: '412 GB free', pct: 58 },
        { label: 'Temp', value: '46 °C', pct: 46 },
      ],
      procs_head: ['process', 'cpu', 'mem'],
      procs: [
        { name: 'node server.js', cpu: '12.4%', mem: '820 MB' },
        { name: 'claude', cpu: '6.1%', mem: '540 MB' },
        { name: 'postgres', cpu: '3.8%', mem: '310 MB' },
        { name: 'tmux: server', cpu: '1.2%', mem: '48 MB' },
        { name: 'sshd', cpu: '0.4%', mem: '12 MB' },
      ],
    },
    ios: {
      screen_title: 'Settings',
      rows: ['Network', 'Notifications', 'Privacy'],
      button: 'Continue',
      actions: ['Tap and gestures', 'Keyboard', 'Home · Lock · Volume', 'Screenshot'],
      caption: 'iPhone 16e · WDA · 25 fps on the LAN',
    },
    kanban: {
      columns: [
        { title: 'Backlog', cards: [{ text: 'SSH retry', chip: '' }, { text: 'Export notes', chip: '' }] },
        { title: 'To do', cards: [{ text: 'Ticket sync', chip: 'LIN-42' }, { text: 'Tab shortcuts', chip: '' }] },
        { title: 'Doing', cards: [{ text: 'iOS simulator', chip: '' }] },
        { title: 'Done', cards: [{ text: 'Paste an image', chip: '' }, { text: 'Kanban per project', chip: '' }, { text: 'E-mail sign-in', chip: '' }] },
      ],
    },
  },
  numbers: [
    { value: '1', label: 'docker compose to bring everything up' },
    { value: '3', label: 'steps to your first terminal' },
    { value: '0', label: 'AI tokens stored' },
  ],
  features: {
    link: 'See features',
    title: 'One place for your terminal day',
    lead: 'Everything you reopen every morning, already open.',
    items: [
      { title: 'Terminals that don’t die', text: 'Every tab is a tmux session on the target machine. Close the browser, switch computers, come back tomorrow: the shell is where you left it.' },
      { title: 'Machines › Projects › Tabs', text: 'Register your machines (local or SSH), organize by project with the right folder and open as many tabs as you need. A folder and disk browser helps pick the directory.' },
      { title: 'Made for AI agents', text: 'Paste images and drop files straight into Claude Code’s terminal. Select and copy even while the app owns the mouse. UTF-8 locale guaranteed on every machine.' },
      { title: 'Kanban, notes and tickets', text: 'Tasks per project with Backlog › To do › Doing › Done, markdown notes with autosave and ticket sync from Linear, Jira and GitHub.' },
      { title: 'Your AI account limits', text: 'See what is left of the Claude, ChatGPT and Gemini usage windows, read from the CLI logins on your machines. No token is stored.' },
      { title: 'Live hardware', text: 'CPU, memory, disks, temperatures and processes of every machine, refreshed every 5 seconds. iOS simulator on screen, with touch and keyboard.' },
    ],
  },
  how: {
    link: 'See how to install',
    title: 'How it works',
    steps: [
      { title: 'Run it with Docker', text: 'docker compose --profile prod up -d. Postgres, login e-mail and the app. Publish on your LAN or through a Cloudflare Tunnel.' },
      { title: 'Authorize the key', text: 'termhub generates its own SSH key. The machine form shows a ready-to-paste command and tests the connection, explaining what is missing.' },
      { title: 'Open a terminal', text: 'Pick the machine and the project folder, done. ⌘T opens another tab, ⌘1..9 switches. Everything keeps running when you close the tab.' },
    ],
    stack_label: 'Stack',
    stack: 'Node.js + Fastify, WebSocket, node-pty and Postgres on the server. React, Vite and xterm.js in the browser. Sign-in by e-mail code, password or Google, with Cloudflare Access support. Terminal content is never logged.',
  },
  cloud: {
    badge: 'coming soon',
    title: 'termhub Cloud',
    lead: 'The same experience with no server to maintain: your machines connect to termhub Cloud and you reach them from anywhere. It is waitlist-only for now; sign up to get an invite.',
    perks: ['No Docker, no proxy, no tunnel: connect the machine and go', 'Sign-in and allowlist built in, with teams and permissions', 'Invites in sign-up order'],
    form: {
      title: 'Join the waitlist',
      first: 'First name',
      last: 'Last name',
      email: 'E-mail',
      phone: 'Phone',
      ddi: 'Country',
      ddd: 'Area',
      number: 'number',
      linkedin: 'LinkedIn (optional)',
      github: 'GitHub (optional)',
      handle_hint: 'handle or profile URL',
      submit: 'Send me an invite',
      sending: 'Sending…',
      done_title: 'You’re on the list!',
      done_text: 'We will e-mail you when your invite is ready.',
      already: 'This e-mail is already on the waitlist.',
      error: 'Could not send right now. Please try again in a moment.',
      privacy: 'We only use your data for the termhub Cloud invite.',
    },
  },
  cta: { title: 'Run it on your network today', lead: 'One docker compose, one user created from the CLI, and your machines’ terminals in the browser.', install: 'Install', app: 'Open the app' },
  footer: { docs: 'Documentation', coffee: '☕ Buy me a coffee', made: 'made in Goiânia' },
};

export const DICT: Record<Lang, typeof pt> = { pt, en };
export type Dict = typeof pt;

export const LangContext = createContext<{ lang: Lang; t: Dict; setLang: (l: Lang) => void }>({ lang: 'pt', t: pt, setLang: () => {} });
export const useLang = () => useContext(LangContext);
