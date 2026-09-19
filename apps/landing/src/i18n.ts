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
  meta: {
    title: 'termhub — os terminais das suas máquinas, no navegador',
    description: 'Terminais de todas as suas máquinas no navegador, organizados por máquina, projeto e tab. Cada tab é uma sessão tmux persistente. Self-hosted e open source (MIT).',
  },
  nav: { features: 'Recursos', agents: 'Agentes', how: 'Como funciona', compare: 'Comparar', cloud: 'Cloud', faq: 'FAQ', github: 'GitHub', app: 'Entrar no app' },
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
      { title: 'Máquinas › Projetos › Tabs', text: 'Conecte suas máquinas com o agente, organize por projeto com a pasta certa e abra quantas tabs precisar. Um navegador de pastas e discos ajuda a escolher o diretório.' },
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
      { title: 'Conecte a máquina', text: 'npm i -g @termhub/agent e o comando de conexão que o app mostra, com o token já preenchido. A máquina conecta por WebSocket de saída: sem abrir porta nem configurar SSH.' },
      { title: 'Abra um terminal', text: 'Escolha a máquina, a pasta do projeto e pronto. ⌘T abre outra tab, ⌘1..9 alterna. Tudo continua rodando quando você fecha a aba.' },
    ],
    stack_label: 'Stack',
    stack: 'Node.js + Fastify, WebSocket, node-pty e Postgres no servidor. React, Vite e xterm.js no navegador. Login por código de e-mail, senha ou Google, com suporte a Cloudflare Access. O conteúdo dos terminais nunca é logado.',
  },
  cloud: {
    badge: 'em breve',
    title: 'termhub Cloud',
    lead: 'A mesma experiência, sem servidor para manter: suas máquinas conectam ao termhub Cloud e você acessa de qualquer lugar. Está em lista de espera; inscreva-se para receber o convite.',
    perks: ['Sem Docker, sem proxy, sem túnel: conecte a máquina e pronto', 'Login e allowlist prontos, com times e permissões', 'Aviso no celular quando o Claude precisar de você', 'Convites em ordem de inscrição'],
    form: {
      title: 'Entrar na lista de espera',
      first: 'Nome',
      last: 'Sobrenome',
      email: 'E-mail (Gmail)',
      email_placeholder: 'voce@gmail.com',
      email_why: 'Por que Gmail?',
      email_tooltip: 'Seu e-mail será cadastrado no Cloudflare Access para liberar o acesso ao termhub Cloud, e o Access exige uma conta Google. Use um endereço @gmail.com.',
      email_invalid: 'Use um endereço @gmail.com.',
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
  agents: {
    title: 'Funciona com qualquer agente',
    lead: 'O termhub é um terminal de verdade: se roda no shell, roda aqui. Sem plugin para instalar nem integração para esperar.',
    items: ['Claude Code', 'Codex', 'Gemini CLI', 'Antigravity', 'Cursor CLI', 'Copilot CLI', 'OpenCode', 'Aider'],
    any: 'qualquer CLI',
    note: 'Para Claude, Codex, Gemini e Antigravity o app ainda mostra quanto resta das janelas de uso, lido do login do CLI na máquina. Nenhum token é armazenado.',
  },
  compare: {
    title: 'termhub comparado',
    lead: 'Onde ele se encaixa entre um IDE de agentes no desktop, um canvas de agentes, o SSH + tmux feito à mão e um IDE com IA.',
    columns: [
      { name: 'termhub', hint: '' },
      { name: 'IDE desktop de agentes', hint: 'ex.: Orca' },
      { name: 'Canvas desktop de agentes', hint: 'ex.: Maestri' },
      { name: 'SSH + tmux na mão', hint: '' },
      { name: 'IDE com IA', hint: 'ex.: Cursor' },
    ],
    rows: [
      { label: 'Roda no navegador; nada a instalar no aparelho de acesso', cells: ['yes', 'no', 'no', 'no', 'no'] },
      { label: 'Várias máquinas em um só painel', cells: ['yes', 'partial', 'partial', 'partial', 'partial'] },
      { label: 'Sessões sobrevivem ao navegador e à troca de computador (tmux)', cells: ['yes', 'partial', 'partial', 'yes', 'no'] },
      { label: 'Acesso remoto por padrão, celular incluso', cells: ['yes', 'partial', 'partial', 'partial', 'no'] },
      { label: 'Times, roles e permissões por recurso', cells: ['yes', 'no', 'no', 'no', 'partial'] },
      { label: 'Self-hosted e open source (MIT)', cells: ['yes', 'yes', 'no', 'yes', 'no'] },
      { label: 'Limites das contas de IA (Claude, Codex, Gemini)', cells: ['yes', 'yes', 'yes', 'no', 'no'] },
    ],
    legend: { yes: 'sim', no: 'não', partial: 'parcial' },
    note: 'Com base nas páginas públicas dos produtos em setembro de 2026. "Parcial" = existe, mas depende de configuração extra ou de um app adicional.',
  },
  faq: {
    title: 'Perguntas frequentes',
    items: [
      { q: 'O que é o termhub?', a: 'Um painel no navegador para os terminais das suas máquinas. Você conecta cada máquina com o agente do termhub, organiza por projeto e abre tabs; cada tab é uma sessão tmux na máquina, que continua rodando quando você fecha o navegador.' },
      { q: 'Preciso instalar algo no computador que uso para acessar?', a: 'Não. Basta um navegador: funciona no notebook, no tablet e no celular. A instalação fica do outro lado: o servidor do termhub (um docker compose) e, em cada máquina que você quer acessar, o agente (@termhub/agent) com tmux.' },
      { q: 'Como conecto uma máquina?', a: 'Instale o agente com npm i -g @termhub/agent (precisa de Node 20+ e tmux), gere um token em Máquinas › Adicionar máquina e rode o termhub-agent connect que o app mostra. Depois, termhub-agent service install deixa o agente rodando em segundo plano (launchd no macOS, systemd no Linux). A conexão sai da máquina por WebSocket: não precisa abrir porta, configurar SSH nem estar na mesma rede.' },
      { q: 'É seguro? Onde ficam as credenciais?', a: 'O agente abre uma conexão de saída até o servidor, então nenhuma porta fica exposta na máquina. O token de pareamento aparece uma vez só e o servidor guarda apenas o hash dele; o servidor nunca manda texto de shell para o agente, só pede operações nomeadas (abrir um terminal, listar sessões…). Para mostrar os limites das contas de IA, o login do CLI é lido na máquina na hora da consulta: nenhum token de IA é armazenado e o conteúdo dos terminais nunca é logado.' },
      { q: 'Funciona com o Claude Code?', a: 'Sim, e foi feito pensando nele: cole imagens e arraste arquivos direto no terminal, dite o prompt por voz (a transcrição roda no seu servidor) e selecione e copie mesmo com o app usando o mouse. Codex, Gemini CLI, Antigravity ou qualquer outra CLI rodam do mesmo jeito, porque é um terminal de verdade.' },
      { q: 'Como sei quando o agente de IA precisa de mim?', a: 'Instale os hooks do monitor na máquina, com um clique no app. Quando o Claude Code ou o Codex termina de responder ou para esperando uma permissão, a tab ganha um ponto laranja, o projeto é marcado na barra lateral e um aviso aparece no canto da tela. A home lista tudo o que está esperando você, agrupado por máquina.' },
      { q: 'Funciona no Windows?', a: 'Para acessar, sim: é só abrir o navegador. Como máquina de destino, o agente roda em macOS e Linux e precisa de tmux; no Windows, use o WSL.' },
      { q: 'É grátis?', a: 'Sim. O termhub é open source sob licença MIT: rode na sua rede com quantas máquinas e usuários quiser. O termhub Cloud, hospedado por nós, será a opção paga para quem não quer manter servidor.' },
      { q: 'O que é o termhub Cloud?', a: 'A mesma experiência sem servidor para manter: você conecta suas máquinas com o agente e acessa de qualquer lugar, com login, times e permissões prontos. Está em alpha fechado, e os convites saem em ordem de inscrição na lista de espera.' },
      { q: 'Como contribuir?', a: 'O código está no GitHub. Issues, PRs e ideias são bem-vindos; o README explica como rodar em desenvolvimento.' },
    ],
  },
  cta: { title: 'Rode na sua rede hoje', lead: 'Um docker compose, um usuário criado pela CLI, e os terminais das suas máquinas no navegador.', install: 'Instalar', app: 'Entrar no app' },
  cookies: {
    title: 'Cookies',
    text: 'Usamos o Google Analytics para medir as visitas a este site. Ele só é carregado se você aceitar.',
    accept: 'Aceitar',
    decline: 'Recusar',
  },
  footer: { docs: 'Documentação', brand: 'Marca', coffee: '☕ Buy me a coffee', cookies: 'Cookies', made: 'feito em Goiânia' },
  // /brand/ — logo, colors and typography for anyone writing about termhub
  brand: {
    meta: {
      title: 'Marca termhub — logo, cores e tipografia',
      description: 'Símbolo, logotipo, paleta e tipografia do termhub para download, com as regras de uso. SVG e PNG num único .zip.',
    },
    back: 'Início',
    title: 'Marca',
    lead: 'Vai escrever, apresentar ou fazer um vídeo sobre o termhub? Aqui está tudo o que você precisa: símbolo, logotipo, cores e tipografia, prontos para usar.',
    download_all: 'Baixar tudo (.zip)',
    download_hint: 'SVG, PNG em vários tamanhos e um README com as cores.',
    mark: {
      title: 'Símbolo',
      text: 'A janela de terminal com o prompt. É o ícone do app e o favicon; use quando o espaço for pequeno ou quadrado (avatar, ícone, favicon).',
    },
    logo: {
      title: 'Logotipo',
      text: 'Símbolo + wordmark + tagline. Prefira esta versão sempre que houver espaço horizontal. A versão para fundo claro troca só a cor do texto; o símbolo é sempre escuro.',
      on_dark: 'sobre fundo escuro',
      on_light: 'sobre fundo claro',
    },
    social: {
      title: 'Redes sociais',
      text: 'Artes 4:3 (1600×1200) prontas para LinkedIn e Instagram. Clique para baixar.',
      items: [
        { file: 'termhub-social-logo.png', label: 'Logotipo' },
        { file: 'termhub-social-tagline-pt.png', label: 'Tagline (pt)' },
        { file: 'termhub-social-tagline-en.png', label: 'Tagline (en)' },
      ],
    },
    colors: {
      title: 'Cores',
      text: 'O roxo do gradiente é o único acento: aparece no prompt do símbolo, no “hub” do wordmark e nos botões. O resto da paleta são tons de superfície.',
      items: [
        { name: 'Gradiente (CTA)', value: '#5b63d3 → #7c87f7', role: 'prompt, “hub”, botões' },
        { name: 'Accent', value: '#98a4f7', role: 'links e acentos pequenos' },
        { name: 'Canvas', value: '#0f101a', role: 'fundo da página e do símbolo' },
        { name: 'Surface', value: '#151621', role: 'cartões' },
        { name: 'Border', value: '#1f2433', role: 'bordas e contornos' },
        { name: 'Text', value: '#e6e8ee', role: 'wordmark, títulos' },
        { name: 'Frost', value: '#c9d3ee', role: 'texto secundário' },
        { name: 'Muted', value: '#646e87', role: 'texto de apoio' },
      ],
    },
    type: {
      title: 'Tipografia',
      text: 'Duas famílias, ambas livres: Inter para interface e texto, JetBrains Mono para o wordmark e tudo que é terminal.',
      items: [
        { name: 'Inter', role: 'Interface e texto', sample: 'Os terminais das suas máquinas, no navegador.', mono: false },
        { name: 'JetBrains Mono', role: 'Wordmark e terminal', sample: 'termhub $ tmux attach -t projeto', mono: true },
      ],
    },
    rules: {
      title: 'Uso',
      dos: ['Use os arquivos originais, sem redesenhar.', 'Deixe em volta um respiro de pelo menos a altura das bolinhas da janela.', 'Sobre fundo claro, use a versão “sobre fundo claro”.'],
      donts: ['Não recolora, não gira e não estica.', 'Não coloque o símbolo dentro de outra forma.', 'Não escreva “TermHub” ou “Term Hub”: é sempre termhub, em minúsculas.'],
      dos_title: 'Faça',
      donts_title: 'Evite',
    },
    files: { svg: 'SVG', png: 'PNG' },
  },
};

const en: typeof pt = {
  meta: {
    title: 'termhub — your machines’ terminals, in the browser',
    description: 'Every machine’s terminal in your browser, organized by machine, project and tab. Each tab is a persistent tmux session. Self-hosted and open source (MIT).',
  },
  nav: { features: 'Features', agents: 'Agents', how: 'How it works', compare: 'Compare', cloud: 'Cloud', faq: 'FAQ', github: 'GitHub', app: 'Open the app' },
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
      { title: 'Machines › Projects › Tabs', text: 'Connect your machines with the agent, organize by project with the right folder and open as many tabs as you need. A folder and disk browser helps pick the directory.' },
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
      { title: 'Connect the machine', text: 'npm i -g @termhub/agent and the connect command the app shows, token already filled in. The machine connects over an outbound WebSocket: no port to open, no SSH to set up.' },
      { title: 'Open a terminal', text: 'Pick the machine and the project folder, done. ⌘T opens another tab, ⌘1..9 switches. Everything keeps running when you close the tab.' },
    ],
    stack_label: 'Stack',
    stack: 'Node.js + Fastify, WebSocket, node-pty and Postgres on the server. React, Vite and xterm.js in the browser. Sign-in by e-mail code, password or Google, with Cloudflare Access support. Terminal content is never logged.',
  },
  cloud: {
    badge: 'coming soon',
    title: 'termhub Cloud',
    lead: 'The same experience with no server to maintain: your machines connect to termhub Cloud and you reach them from anywhere. It is waitlist-only for now; sign up to get an invite.',
    perks: ['No Docker, no proxy, no tunnel: connect the machine and go', 'Sign-in and allowlist built in, with teams and permissions', 'A ping on your phone when Claude needs you', 'Invites in sign-up order'],
    form: {
      title: 'Join the waitlist',
      first: 'First name',
      last: 'Last name',
      email: 'E-mail (Gmail)',
      email_placeholder: 'you@gmail.com',
      email_why: 'Why Gmail?',
      email_tooltip: 'Your e-mail is added to Cloudflare Access to grant you access to termhub Cloud, and Access requires a Google account. Use a @gmail.com address.',
      email_invalid: 'Use a @gmail.com address.',
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
  agents: {
    title: 'Works with any agent',
    lead: 'termhub is a real terminal: if it runs in a shell, it runs here. No plugin to install, no integration to wait for.',
    items: ['Claude Code', 'Codex', 'Gemini CLI', 'Antigravity', 'Cursor CLI', 'Copilot CLI', 'OpenCode', 'Aider'],
    any: 'any CLI',
    note: 'For Claude, Codex, Gemini and Antigravity the app also shows what is left of the usage windows, read from the CLI login on the machine. No token is stored.',
  },
  compare: {
    title: 'termhub compared',
    lead: 'Where it fits next to a desktop agent IDE, an agent canvas, hand-rolled SSH + tmux and an AI IDE.',
    columns: [
      { name: 'termhub', hint: '' },
      { name: 'Desktop agent IDE', hint: 'e.g. Orca' },
      { name: 'Desktop agent canvas', hint: 'e.g. Maestri' },
      { name: 'SSH + tmux by hand', hint: '' },
      { name: 'AI IDE', hint: 'e.g. Cursor' },
    ],
    rows: [
      { label: 'Runs in the browser; nothing to install on the device you use', cells: ['yes', 'no', 'no', 'no', 'no'] },
      { label: 'Several machines in one dashboard', cells: ['yes', 'partial', 'partial', 'partial', 'partial'] },
      { label: 'Sessions survive the browser and switching computers (tmux)', cells: ['yes', 'partial', 'partial', 'yes', 'no'] },
      { label: 'Remote access by default, phone included', cells: ['yes', 'partial', 'partial', 'partial', 'no'] },
      { label: 'Teams, roles and per-resource permissions', cells: ['yes', 'no', 'no', 'no', 'partial'] },
      { label: 'Self-hosted and open source (MIT)', cells: ['yes', 'yes', 'no', 'yes', 'no'] },
      { label: 'AI account limits (Claude, Codex, Gemini)', cells: ['yes', 'yes', 'yes', 'no', 'no'] },
    ],
    legend: { yes: 'yes', no: 'no', partial: 'partial' },
    note: 'Based on the products’ public pages as of September 2026. "Partial" = available, but needs extra setup or a separate app.',
  },
  faq: {
    title: 'Frequently asked questions',
    items: [
      { q: 'What is termhub?', a: 'A browser dashboard for your machines’ terminals. You connect each machine with the termhub agent, organize it by project and open tabs; each tab is a tmux session on the machine that keeps running when you close the browser.' },
      { q: 'Do I need to install anything on the device I use to access it?', a: 'No. A browser is enough: it works on the laptop, the tablet and the phone. The install happens on the other side: the termhub server (one docker compose) and, on each machine you want to reach, the agent (@termhub/agent) with tmux.' },
      { q: 'How do I connect a machine?', a: 'Install the agent with npm i -g @termhub/agent (it needs Node 20+ and tmux), generate a token under Machines › Add machine and run the termhub-agent connect command the app shows. Then termhub-agent service install keeps the agent running in the background (launchd on macOS, systemd on Linux). The connection goes out from the machine over a WebSocket: no port to open, no SSH to set up, no need to be on the same network.' },
      { q: 'Is it secure? Where do the credentials live?', a: 'The agent opens an outbound connection to the server, so no port is exposed on the machine. The pairing token is shown only once and the server keeps only its hash; the server never sends shell text to the agent, it only asks for named operations (open a terminal, list sessions…). To show AI account limits, the CLI login is read on the machine at query time: no AI token is stored and terminal content is never logged.' },
      { q: 'Does it work with Claude Code?', a: 'Yes, and it was built with it in mind: paste images and drop files straight into the terminal, dictate the prompt by voice (transcription runs on your server) and select and copy even while the app owns the mouse. Codex, Gemini CLI, Antigravity or any other CLI run the same way, because it is a real terminal.' },
      { q: 'How do I know when the AI agent needs me?', a: 'Install the monitor hooks on the machine with one click in the app. When Claude Code or Codex finishes replying or stops to wait for a permission, the tab gets an orange dot, the project is flagged in the sidebar and a toast shows up in the corner of the screen. The home page lists everything waiting on you, grouped by machine.' },
      { q: 'Does it work on Windows?', a: 'To access it, yes: just open the browser. As a target machine, the agent runs on macOS and Linux and needs tmux; on Windows, use WSL.' },
      { q: 'Is it free?', a: 'Yes. termhub is open source under the MIT license: run it on your network with as many machines and users as you like. termhub Cloud, hosted by us, will be the paid option for those who do not want to maintain a server.' },
      { q: 'What is termhub Cloud?', a: 'The same experience with no server to maintain: you connect your machines with the agent and reach them from anywhere, with sign-in, teams and permissions built in. It is in closed alpha, and invites go out in waitlist sign-up order.' },
      { q: 'How can I contribute?', a: 'The code is on GitHub. Issues, PRs and ideas are welcome; the README explains how to run it in development.' },
    ],
  },
  cta: { title: 'Run it on your network today', lead: 'One docker compose, one user created from the CLI, and your machines’ terminals in the browser.', install: 'Install', app: 'Open the app' },
  cookies: {
    title: 'Cookies',
    text: 'We use Google Analytics to measure visits to this site. It only loads if you accept.',
    accept: 'Accept',
    decline: 'Decline',
  },
  footer: { docs: 'Documentation', brand: 'Brand', coffee: '☕ Buy me a coffee', cookies: 'Cookies', made: 'made in Goiânia' },
  brand: {
    meta: {
      title: 'termhub brand — logo, colors and typography',
      description: 'The termhub mark, logo, palette and typography for download, with usage rules. SVG and PNG in a single .zip.',
    },
    back: 'Home',
    title: 'Brand',
    lead: 'Writing, presenting or making a video about termhub? Here is everything you need: mark, logo, colors and typography, ready to use.',
    download_all: 'Download all (.zip)',
    download_hint: 'SVG, PNG in several sizes and a README with the colors.',
    mark: {
      title: 'Mark',
      text: 'The terminal window with the prompt. It is the app icon and the favicon; use it when the space is small or square (avatar, icon, favicon).',
    },
    logo: {
      title: 'Logo',
      text: 'Mark + wordmark + tagline. Prefer it whenever there is horizontal room. The light-background version only changes the text color; the mark is always dark.',
      on_dark: 'on a dark background',
      on_light: 'on a light background',
    },
    social: {
      title: 'Social media',
      text: '4:3 artwork (1600×1200) ready for LinkedIn and Instagram. Click to download.',
      items: [
        { file: 'termhub-social-logo.png', label: 'Logo' },
        { file: 'termhub-social-tagline-pt.png', label: 'Tagline (pt)' },
        { file: 'termhub-social-tagline-en.png', label: 'Tagline (en)' },
      ],
    },
    colors: {
      title: 'Colors',
      text: 'The gradient purple is the only accent: it shows up in the mark’s prompt, in the wordmark’s “hub” and on buttons. The rest of the palette is surface tones.',
      items: [
        { name: 'Gradient (CTA)', value: '#5b63d3 → #7c87f7', role: 'prompt, “hub”, buttons' },
        { name: 'Accent', value: '#98a4f7', role: 'links and small accents' },
        { name: 'Canvas', value: '#0f101a', role: 'page and mark background' },
        { name: 'Surface', value: '#151621', role: 'cards' },
        { name: 'Border', value: '#1f2433', role: 'borders and outlines' },
        { name: 'Text', value: '#e6e8ee', role: 'wordmark, headings' },
        { name: 'Frost', value: '#c9d3ee', role: 'secondary text' },
        { name: 'Muted', value: '#646e87', role: 'supporting text' },
      ],
    },
    type: {
      title: 'Typography',
      text: 'Two families, both free: Inter for interface and text, JetBrains Mono for the wordmark and anything terminal.',
      items: [
        { name: 'Inter', role: 'Interface and text', sample: 'Your machines’ terminals, in the browser.', mono: false },
        { name: 'JetBrains Mono', role: 'Wordmark and terminal', sample: 'termhub $ tmux attach -t project', mono: true },
      ],
    },
    rules: {
      title: 'Usage',
      dos: ['Use the original files, do not redraw them.', 'Leave clear space around it of at least the height of the window dots.', 'On a light background, use the “on a light background” version.'],
      donts: ['Do not recolor, rotate or stretch it.', 'Do not put the mark inside another shape.', 'Do not write “TermHub” or “Term Hub”: it is always termhub, lowercase.'],
      dos_title: 'Do',
      donts_title: 'Avoid',
    },
    files: { svg: 'SVG', png: 'PNG' },
  },
};

export const DICT: Record<Lang, typeof pt> = { pt, en };
export type Dict = typeof pt;

export const LangContext = createContext<{ lang: Lang; t: Dict; setLang: (l: Lang) => void }>({ lang: 'pt', t: pt, setLang: () => {} });
export const useLang = () => useContext(LangContext);
