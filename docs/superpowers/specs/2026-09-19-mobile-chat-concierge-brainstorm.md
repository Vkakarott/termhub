# App mobile de chat + concierge por computador — brainstorm

**Status:** brainstorm em andamento, ainda não é um spec aprovado. Falta decidir o
alvo da v1 (ver [Pergunta em aberto](#pergunta-em-aberto)); depois vêm as abordagens
de orquestração, o design por seções e o spec definitivo.

**Data:** 2026-09-19

## O pedido

Um aplicativo mobile que funciona como um ChatGPT: em vez de ver o terminal, cada
coisa aberta vira uma janela de conversa. O ideal é uma única interface, um chat por
computador.

## O que já existe e ajuda

- **Agent daemon por computador.** Ele mantém um WebSocket de saída para o servidor,
  e o servidor só chama RPCs nomeadas (fs, tmux, hooks, ai). Dá para usar a partir do
  celular sem SSH.
- **Aba = sessão tmux.** Já existe `POST /api/tabs/:id/input` (send-keys) e
  `captureScreen`. Hoje o input devolve 409 em máquinas com agent. O spec do MCP
  prevê as RPCs `tmux.sendText/sendKey` que corrigem isso.
- **Estado das IAs em tempo real.** Os hooks do Claude/Codex geram os estados
  `working | waiting_input | waiting_permission | idle`, enviados por `/ws/monitor`.
- **Uso e crédito por conta de IA.** Em `apps/server/src/ai/*` há rastreio para
  Claude, ChatGPT, Gemini e Antigravity, com janelas de 5h e 7d. Isso serve de base
  para escolher a IA com mais token disponível.
- **MCP global especificado, ainda não implementado.** O spec é
  `docs/superpowers/specs/2026-09-18-global-terminal-mcp-design.md`. As tools
  previstas são `open_tab`, `send_input`, `read_screen`, `wait_for_state`, `find` e
  `start_agent`. Esse spec deixa o chat in-app explicitamente fora de escopo, e é
  essa parte que estamos desenhando agora.
- **API tokens `thb_pat_…`** na branch `feat/api-tokens`. É o caminho de
  autenticação para o mobile, porque cookie com CSRF não serve para app.
- Não existe nenhum app mobile no repositório.

## O que foi entendido do pedido

- **App mobile.** Ele lista computadores e projetos e permite adicionar projeto pelo
  navegador de pastas. Não adiciona computador; isso continua só na web. A interface
  principal é um chat por computador.
- **Concierge.** Cada computador tem um "terminal geral" oculto, que não aparece na
  lista de abas. Ele roda a IA com mais crédito disponível, possivelmente num modelo
  barato, com o MCP do termhub conectado.
- **Fluxo.** Texto ou áudio no app → API → backend injeta no concierge → a IA decide
  e age via MCP (listar instâncias rodando, mandar comando para uma aba etc.) → monta
  a resposta → o backend devolve ao app. Para o áudio, o container `termhub-whisper`
  já está de pé.
- **Persistência.** Toda mensagem de ida e toda mensagem de volta é gravada.

### Suposição (a confirmar)

Isso depende das PRs de API tokens e das tools MCP de terminal. Por isso o trabalho
se divide em três sub-projetos:

1. Orquestração do chat no servidor.
2. App mobile.
3. Os pré-requisitos do MCP, que já estão planejados.

O spec do (1) vem primeiro, porque ele define o contrato que o app consome.

## Pergunta em aberto

O pedido descreve duas coisas diferentes; falta definir qual é o alvo da v1:

- **A. Só o concierge.** Um chat por computador. Para interagir com o Claude de um
  projeto, você pede ao concierge ("manda pro projeto X fazer Y", "o que o X está
  esperando?") e ele repassa e resume via MCP. É mais simples, com uma interface só.
- **B. Concierge + chat por terminal.** Além do chat geral, cada aba com IA aberta
  vira uma conversa própria no app. Você fala direto com aquele Claude e vê as
  respostas dele como balões, sem intermediário. Fica mais parecido com um ChatGPT
  com várias conversas, mas exige transformar a saída de cada TUI em mensagens. Essa
  é a parte difícil.
- **C. A agora, com o modelo de dados já preparado para B depois.**

**Recomendação: C.** Entrega rápido o chat por computador, que é o ideal descrito, e
a tabela de conversas já nasce com `machineId` e `tabId` opcional, então o B entra
depois sem migração dolorosa.

## Próximos passos

1. Decidir A, B ou C.
2. Comparar 2–3 abordagens de orquestração do concierge (por exemplo, TUI em tmux com
   injeção de texto e leitura de tela versus execução headless com saída
   estruturada).
3. Design por seções: arquitetura, modelo de dados, fluxo de mensagens, erros, testes.
4. Spec definitivo em `docs/superpowers/specs/` e plano de implementação.
