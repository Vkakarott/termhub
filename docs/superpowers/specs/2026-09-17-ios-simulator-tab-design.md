# Aba de simulador iOS no termhub (via WebDriverAgent)

Data: 2026-09-17. Status: aprovado em conversa, aguardando revisão do texto.

## Objetivo

Mostrar no navegador, dentro de um projeto do termhub, a tela de um simulador iOS que roda numa máquina Mac cadastrada, com interação (toque, arrastar, teclado, botões físicos, rotação e screenshot). A aba fica ao lado das abas de terminal do projeto.

Fora de escopo nesta versão: compilar ou instalar o app do projeto no simulador (isso continua sendo feito nos terminais), dispositivos físicos, Android, áudio.

## Decisões já tomadas

- **Motor**: WebDriverAgent (WDA, `appium/WebDriverAgent`). Validado em 2026-09-17 no Mac mini com Xcode 26.4 e iOS 26.3: compila sem assinatura de código, runner sobe em ~30 s, MJPEG chega a ~27 fps com escala 25% (55 KB/frame) e tap, home e digitação respondem. Teto prático é ~27 fps; 60 fps não é alcançável porque o gargalo é a captura no simulador.
- **Provisionamento**: o termhub instala e compila o WDA na máquina (botão na tela da máquina), em `~/.termhub/WebDriverAgent`.
- **Escolha do aparelho**: por aba, na criação ou depois, com seletor dentro da aba. Uma aba pode nascer sem aparelho.
- **Interação**: toque, arrastar/scroll, teclado, Home, Bloquear, volume, girar e download de screenshot PNG.
- **Topologia**: servidor como proxy. Runner do WDA em tmux na máquina, túnel `ssh -N -L` do container até as portas do WDA, WebSocket novo entre navegador e servidor carregando frames e comandos. Nada do WDA exposto fora do túnel.

## Modelo de dados

Migration Prisma, sem impacto nas abas existentes:

- `Tab.kind`: enum `TabKind { terminal, simulator }`, padrão `terminal`.
- `Tab.simulatorUdid`: `String?`, nulo enquanto a aba não tem aparelho.
- `Tab.tmuxSession`: passa a `String?` (mantém `@unique`; Postgres permite vários nulos). Abas `terminal` continuam obrigadas a ter sessão (validado na aplicação).
- `Machine`: sem mudança de schema. A detecção de status existente (`DETECT_SCRIPT` em `server/src/terminal/machine-exec.ts`) ganha um teste de arquivo: se existir `~/.termhub/WebDriverAgent/DerivedData/Build/Products/Debug-iphonesimulator/WebDriverAgentRunner-Runner.app`, entra `wda` em `capabilities`.
- Estado de runtime (portas, túnel, sessionId do WDA, viewers) fica em memória no servidor, num mapa por `machineId + udid`. Após reinício, o servidor redescobre runners pelo `tmux has-session` e reabre o túnel.

## Provisionamento do WDA na máquina

Tela da máquina ganha o bloco "Simulador iOS" com três estados:

| Estado | Condição | UI |
|---|---|---|
| indisponível | `os !== 'Darwin'` ou sem `xcodebuild` em `capabilities` | texto explicando |
| não preparado | Darwin + xcodebuild, sem `wda` | botão "Preparar" |
| preparando | setup em andamento | tail do log, atualizado a cada 3 s |
| pronto | `wda` em `capabilities` | versão do WDA (do `package.json` do checkout) e botão "Atualizar" |

Endpoints:

- `POST /api/machines/:id/simulator/setup`: cria na máquina a sessão tmux `termhub-wda-setup` (erro 409 se já existe) rodando um script único que faz `git clone --depth 1 https://github.com/appium/WebDriverAgent ~/.termhub/WebDriverAgent` (ou `git pull` se já existe) e depois `xcodebuild build-for-testing -project WebDriverAgent.xcodeproj -scheme WebDriverAgentRunner -destination 'generic/platform=iOS Simulator' -derivedDataPath DerivedData CODE_SIGNING_ALLOWED=NO`. Saída em `~/.termhub/wda-setup.log`; código de saída em `~/.termhub/wda-setup.status` (arquivo removido no início de cada execução).
- `GET /api/machines/:id/simulator/setup`: devolve `{ state: 'idle' | 'running' | 'ok' | 'failed', tail: string[] }` lendo `tmux has-session`, o status e as últimas 40 linhas do log via `runOnMachine`.
- Ao detectar `ok`, o servidor refaz a detecção de status da máquina.

Rodar dentro do tmux garante que o build sobrevive a reinício do servidor e queda do SSH.

## Ciclo de vida da sessão do simulador

Endpoints:

- `GET /api/machines/:id/simulators`: `xcrun simctl list devices -j`, filtrando `isAvailable`, devolvendo `{ udid, name, runtime, state }` ordenado com bootados primeiro.
- `PATCH /api/tabs/:id` aceita `simulatorUdid` (só para `kind = simulator`). Trocar o aparelho fecha os WS abertos da aba, que reconectam com o novo UDID.
- `POST /api/projects/:id/tabs` aceita `kind` e `simulatorUdid` opcional. Abas `simulator` não criam sessão tmux.
- `GET /api/tabs/:id/simulator/screenshot`: PNG via `GET /screenshot` do WDA, com `Content-Disposition: attachment`.

`SimulatorSessionManager` (`server/src/simulator/session-manager.ts`), um por processo:

1. `acquire(machine, udid, viewer)`: incrementa refcount da chave `machineId:udid`. Se já existe sessão pronta, anexa o viewer e retorna.
2. Boot: `xcrun simctl boot <udid>`; saída "already booted" é sucesso. Não abre o Simulator.app.
3. Portas no Mac: `h = fnv1a(udid) % 100`; `wdaPort = 8100 + h`, `mjpegPort = 9100 + h`. Determinístico, sem estado persistido.
4. Runner: sessão tmux `termhub-wda-<8 primeiros chars do udid>` rodando `cd ~/.termhub/WebDriverAgent && xcodebuild test-without-building -project WebDriverAgent.xcodeproj -scheme WebDriverAgentRunner -destination id=<udid> -derivedDataPath DerivedData USE_PORT=<wdaPort> MJPEG_SERVER_PORT=<mjpegPort>`. Se a sessão já existe, reaproveita.
5. Túnel: para máquina `ssh`, um processo `ssh -N -o ExitOnForwardFailure=yes -L 127.0.0.1:<lp>:127.0.0.1:<wdaPort> -L 127.0.0.1:<lm>:127.0.0.1:<mjpegPort>` com portas locais livres (`net` listen em 0 para descobrir). Para máquina `local`, usa as portas diretamente.
6. Espera `GET /status` responder `ready: true` (poll a cada 1 s, até 90 s). Cria sessão WDA (`POST /session` com capabilities vazias) e aplica `POST /session/:id/appium/settings` com `mjpegServerFramerate: 30` e a escala/qualidade pedidas pelo cliente (padrão 50 e 40). Lê `GET /session/:id/window/size` para o tamanho lógico.
7. Um único leitor HTTP do MJPEG por sessão (`server/src/simulator/mjpeg.ts`) faz o parse do multipart e emite um `Buffer` por frame para todos os viewers.
8. `release(viewer)`: decrementa refcount. Ao chegar a zero, agenda encerramento em 5 min. Encerrar = `DELETE /session/:id`, matar o túnel, `tmux kill-session` do runner. O aparelho continua bootado. Um novo `acquire` dentro dos 5 min cancela o encerramento.
9. Falha do runner (túnel morreu, `/status` sem resposta por 10 s, ou `tmux has-session` falhou): emite `error` aos viewers e descarta a sessão do mapa. O cliente oferece "Reconectar", que faz `acquire` de novo.

Eventos de settings (escala/qualidade) de um viewer valem para a sessão inteira, porque o stream é único.

## Protocolo do WebSocket

Rota `/ws/sim/<tabId>`, tratada no mesmo `upgrade` de `server/src/terminal/ws.ts` (mesma auth por cookie e checagem de origem). Tab precisa ser `kind = simulator`; sem UDID responde `status: no_device` e fica aguardando (o cliente mostra o seletor).

Servidor → cliente:

- Binário: um frame JPEG completo.
- `{ type: 'status', state: 'booting' | 'starting' | 'ready' | 'no_device' | 'error', message?: string, tail?: string[] }`
- `{ type: 'screen', width: number, height: number, orientation: 'portrait' | 'landscape' }` (pontos lógicos)

Cliente → servidor (todos JSON, validados com zod):

- `{ type: 'tap', x, y }` → W3C actions: `pointerMove`, `pointerDown`, `pause 80`, `pointerUp`.
- `{ type: 'drag', points: [{ x, y, t }] }` → W3C actions com `pointerMove` entre pontos usando as diferenças de `t` como `duration`.
- `{ type: 'keys', text }` → `POST /wda/keys` com `value: [...]` (texto imprimível). `{ type: 'key', name }` para teclas especiais (Enter, Backspace, Tab, Escape, Delete, setas), mapeadas no servidor para os códigos W3C (`\uE007` Enter, `\uE003` Backspace, setas `\uE012`..`\uE015`, `\uE004` Tab).
- `{ type: 'button', name: 'home' | 'lock' | 'volumeUp' | 'volumeDown' }` → `POST /wda/pressButton`.
- `{ type: 'rotate', orientation: 'portrait' | 'landscape' }` → `POST /orientation`; depois o servidor reemite `screen`.
- `{ type: 'settings', scale: number, quality: number }` → settings do WDA.
- `{ type: 'pause' }` / `{ type: 'resume' }`: o servidor para (ou volta) de enviar frames a esse viewer.
- `{ type: 'ping' }` → `{ type: 'pong' }`.

Coordenadas sempre em pontos lógicos; o cliente converte do canvas com base em `screen`.

Controle de fluxo: antes de enviar um frame, o servidor checa `ws.bufferedAmount`; acima de 1 MB descarta o frame. Sempre que volta a ter espaço envia o mais recente. Frames nunca são enfileirados por viewer.

Erros de comando no WDA (HTTP 4xx/5xx) voltam como `{ type: 'toast', message }` e não derrubam a sessão.

## Cliente

- `web/src/components/SimulatorView.tsx`: `<canvas>` que preserva a proporção do aparelho e cabe no espaço da aba, desenhando cada frame com `createImageBitmap`. Foco no canvas habilita o teclado. Mouse: `mousedown/mousemove/mouseup`; se soltar em menos de 200 ms e mover menos de 6 px é `tap`, senão `drag` com pontos amostrados a cada ~16 ms. Roda do mouse vira `drag` vertical curto. `keydown` acumula caracteres e envia `keys` em lote a cada 50 ms. `visibilitychange` manda `pause`/`resume`.
- Barra da aba: seletor de aparelho (lista de `GET /api/machines/:id/simulators`, estado vazio "Escolha um simulador"), Home, Bloquear, Girar, Screenshot, qualidade (`LAN` = escala 50/qualidade 50, `Remoto` = 25/30) e indicador de fps (frames recebidos por segundo).
- `web/src/lib/simulator-connection.ts`: abre o WS, reconecta com backoff, expõe callbacks de frame/status/screen e métodos de envio.
- `TabBar`: botão "+ Simulador" ao lado de "+ Terminal", visível quando a máquina do projeto tem `wda` em `capabilities`. `TerminalsView` renderiza `SimulatorView` quando `tab.kind === 'simulator'`.
- Tela da máquina (`MachineForm` ou página equivalente): bloco "Simulador iOS" descrito acima.

## Erros

| Situação | Comportamento |
|---|---|
| Máquina offline | `status: error` "Máquina offline", botão Reconectar |
| Sem `wda` na máquina | `status: error` com link "Preparar simulador nesta máquina" |
| UDID não existe mais no `simctl list` | `status: error` "Simulador não encontrado", abre o seletor |
| Runner não subiu em 90 s | `status: error` com `tail` das últimas 30 linhas do tmux do runner |
| Túnel caiu | servidor tenta reabrir até 3 vezes (2 s entre tentativas); depois `error` |
| Comando falhou no WDA | `toast`, sessão continua |

Segurança: mesmas regras do WS de terminal. Logs só com metadados (tab, máquina, UDID, portas), nunca frames nem texto digitado.

## Testes

O projeto não tem runner de teste; CI roda typecheck + build. Adicionar `vitest` ao workspace `server` e um passo `npm test -w server` na CI. Escritos em TDD:

- `mjpeg.test.ts`: parser do multipart (frame inteiro num chunk, frame partido em vários chunks, dois frames num chunk, boundary com e sem `--` final).
- `actions.test.ts`: `tap` e `drag` → W3C actions; durações a partir de `t`.
- `keys.test.ts`: mapa de teclas do navegador → valores do `/wda/keys`.
- `ports.test.ts`: hash de porta determinístico e dentro da faixa.
- `session-manager.test.ts`: refcount, encerramento adiado de 5 min (fake timers), cancelamento por novo `acquire`, falha do runner descartando a sessão. WDA, SSH e tmux mockados por interfaces injetadas.

Verificação manual contra o Mac mini, no fim do plano: preparar WDA pela UI, criar aba sem aparelho, escolher o iPhone 16e, ver a imagem, tocar, arrastar, digitar num campo, Home, Bloquear, Girar, baixar screenshot, trocar pra "Remoto" e ver a queda de banda, fechar a aba e confirmar que o runner morre após 5 min, reiniciar o servidor com a aba aberta e ver a reconexão.

## Arquivos previstos

Servidor: `prisma/schema.prisma` + migration; `src/simulator/{session-manager,mjpeg,wda-client,actions,keys,ports,setup}.ts`; `src/simulator/ws.ts` (ou extensão de `src/terminal/ws.ts` para rotear por path); `src/routes/{machines,tabs,projects}.ts`; `src/terminal/machine-exec.ts` (detecção `wda`).

Web: `src/components/{SimulatorView,TabBar,TerminalsView,MachineForm}.tsx`; `src/lib/{simulator-connection,api,types}.ts`.
