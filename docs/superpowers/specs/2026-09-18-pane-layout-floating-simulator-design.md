# Painéis lado a lado e simulador flutuante na área de Terminais

Data: 2026-09-18. Status: aprovado em conversa, aguardando revisão do texto.

## Objetivo

Na seção Terminais de um projeto, mostrar mais de uma aba ao mesmo tempo em arranjos fixos (presets), e permitir que a aba de simulador iOS seja "destacada" para uma janela flutuante, arrastável e redimensionável, dentro dessa mesma área.

Fora de escopo: divisões livres/aninhadas por arrastar abas, redimensionar as células dos presets, janelas flutuantes para terminais, layout salvo no servidor, janela flutuante visível em outras seções (Tarefas, Notas).

## Decisões já tomadas

- **Estado por navegador**: o layout fica em `localStorage`, por projeto. Nada muda no servidor.
- **Presets fixos**, sem drag and drop: `single` (1), `columns` (2 lado a lado), `rows` (2 empilhados), `stack-left` (2 empilhados à esquerda + 1 inteiro à direita), `grid` (2x2, duas colunas com duas empilhadas cada). Proporções 50/50.
- **Janela flutuante só para o simulador**, só dentro da seção Terminais, com "Destacar" e "Encaixar". Uma janela por projeto.
- **Renderização por lista plana com retângulos calculados**: as abas continuam montadas uma única vez e recebem `position: absolute` com o retângulo da célula ou da janela; nada remonta ao mudar o layout (o xterm e o canvas do simulador mantêm WebSocket e contexto).

## Modelo do layout

```ts
type Preset = 'single' | 'columns' | 'rows' | 'stack-left' | 'grid';
interface Floating { tabId: string; x: number; y: number; w: number; h: number } // px, relativos à área de terminais
interface Layout {
  preset: Preset;
  cells: (string | null)[]; // tabId por célula; tamanho = número de células do preset
  focusedCell: number;
  floating: Floating | null;
}
```

- Chave `termhub:layout:<projectId>`. Substitui `termhub:active-tab:<projectId>`; na primeira carga sem layout salvo, o valor antigo (se existir) vira `cells[0]` do preset `single`.
- Número de células por preset: single 1, columns 2, rows 2, stack-left 3, grid 4. Ordem das células: stack-left = [esquerda-cima, esquerda-baixo, direita]; grid = [esq-cima, esq-baixo, dir-cima, dir-baixo]; columns = [esq, dir]; rows = [cima, baixo].
- Invariantes: uma aba aparece em no máximo um lugar (uma célula ou `floating`); `focusedCell` sempre dentro do intervalo; toda `tabId` existe na lista de abas do projeto.

Ações (redutor puro em `web/src/lib/layout.ts`):

| Ação | Efeito |
|---|---|
| `assign(tabId)` | Se a aba já está numa célula, `focusedCell` vira essa célula. Se está flutuando, não faz nada além de focar a janela. Senão, `cells[focusedCell] = tabId`. |
| `assignTo(cell, tabId)` | Mesma regra, mas na célula indicada (dropdown do cabeçalho). Se a aba estava em outra célula, aquela fica vazia. |
| `focus(cell)` | `focusedCell = cell`. |
| `clearCell(cell)` | `cells[cell] = null` (a aba continua existindo na barra). |
| `setPreset(p)` | Mantém `cells[0..n-1]`, descarta o excedente, preenche com `null`; `focusedCell` clampado. |
| `closeTab(tabId)` | Remove de `cells` e de `floating`. |
| `detach(tabId, rect)` | Só para `kind === 'simulator'`: tira da célula, `floating = { tabId, ...rect }`. |
| `dock()` | `cells[focusedCell] = floating.tabId` (a aba que estava lá sai da tela), `floating = null`. |
| `moveFloating(x, y)` / `resizeFloating(w, h)` | Atualiza com clamp (ver janela flutuante). |
| `sanitize(layout, tabs, area)` | Remove ids inexistentes, corrige preset desconhecido para `single`, clampa `focusedCell` e a janela. Rodado ao carregar e sempre que a lista de abas muda. |

Atalhos: ⌘1-9 = `assign(tabs[n-1].id)`; ⌘T = cria terminal e faz `assignTo(primeira célula vazia ?? focusedCell, novaTab)`; ⌘W = fecha a aba de `cells[focusedCell]` (com o diálogo atual). Alternativas ctrl+shift mantidas.

## Motor de renderização

- `cellRects(preset, width, height, gap = 1): Rect[]` é pura: devolve `{ x, y, w, h }` por célula, descontando `gap` px entre células.
- `TerminalsView` mede a área de terminais com `ResizeObserver` e calcula `rect(tabId)`: a célula que contém a aba, ou `floating`, ou `null`.
- Cada aba montada (terminal ou simulador) é envolvida por um `div` com `position: absolute` e o retângulo; sem retângulo, `visibility: hidden` e `pointer-events: none` (não `display: none`, para o xterm continuar medindo e o `fit` não quebrar).
- `active` da aba = tem retângulo. Foco de teclado: a aba da célula focada (ou a janela flutuante quando ela foi a última clicada) recebe `focus()`.
- Camada de células (`PaneLayer`) por cima: para cada célula, cabeçalho de 24 px com o nome da aba, dropdown para trocar, ✕ (= `clearCell`), e borda de destaque na célula focada. Célula vazia mostra "Escolha uma aba", o dropdown e "+ terminal". A camada tem `pointer-events: none`, exceto nos cabeçalhos e nas células vazias. Clicar dentro de uma aba faz `focus(cell)` via `onPointerDown` no wrapper.
- Preset `single`: sem cabeçalho de célula e sem borda; comportamento idêntico ao atual.
- A área útil de cada célula para a aba desconta o cabeçalho (quando existe).

## Janela flutuante

- Componente `FloatingWindow`: barra de título (nome da aba, "Encaixar", ✕ que também encaixa), corpo com a aba, alça de redimensionar no canto inferior direito. Arrasto e redimensionamento com pointer events e `setPointerCapture`; cada movimento chama `moveFloating`/`resizeFloating`.
- Limites: sempre dentro da área de terminais (clamp em x, y, w, h); tamanho mínimo 200×300 px; máximo = área. Redimensionamento livre (o canvas do simulador mantém a proporção dentro do espaço).
- Posição inicial ao destacar: altura = 60% da área, largura = altura × (largura/altura da tela do simulador, ou 9/19.5 se ainda não conhecida), encostada no canto inferior direito com margem de 16 px.
- `z-index` acima das células; ao clicar, vira o alvo do teclado.
- Ao sair da seção Terminais a área inteira some (comportamento atual de `visible`); ao voltar, a janela está onde ficou. Ao carregar com área menor que a janela, `sanitize` reposiciona/reduz.
- Botão "Destacar" na barra da aba de simulador (`SimulatorView`); dentro da janela flutuante o mesmo lugar mostra "Encaixar". Só abas `simulator` têm o botão.

## Interface

- `TabBar`: seletor de preset à direita (cinco botões com ícone do arranjo; ativo em destaque; `title` com o nome). Abas que estão na tela (célula ou flutuando) ganham um marcador (sublinhado com a cor de destaque). O botão 📱 e o + continuam.
- `PaneLayer`/`PaneHeader`: descritos acima. Textos em pt-BR.
- `FloatingWindow`: descrita acima.

## Arquivos

- `web/src/lib/layout.ts`: tipos, `PRESETS` (células por preset), `cellRects`, redutor de ações, `sanitize`, `loadLayout(projectId, tabs, area)`, `saveLayout(projectId, layout)`, `initialFloatingRect(area, aspect)`, `clampFloating(floating, area)`.
- `web/src/lib/layout.test.ts`: testes do módulo puro.
- `web/src/components/PaneLayer.tsx`, `web/src/components/FloatingWindow.tsx`.
- `web/src/components/TerminalsView.tsx`: reescrito por cima do motor; a lógica de estado migra para `layout.ts`.
- `web/src/components/TabBar.tsx`, `web/src/components/SimulatorView.tsx`: botões novos.
- `web/package.json`: `vitest` e script `test`; CI ganha `npm test -w web`.

## Erros e casos de borda

| Situação | Comportamento |
|---|---|
| Aba apagada em outro navegador | `sanitize` na próxima carga da lista de abas; célula fica vazia |
| Preset desconhecido no localStorage | vira `single` |
| Janela flutuante fora da área (tela menor) | `clampFloating` ao carregar e ao redimensionar a área |
| Destacar uma aba que não é simulador | ação ignorada (botão não existe) |
| Encaixar com célula focada ocupada | a aba que estava lá sai da tela (continua na barra) |
| Trocar para preset com menos células | abas excedentes saem da tela, continuam na barra |
| ⌘T sem célula vazia | terminal novo entra na célula focada |

## Testes

- `vitest` no workspace `web` (novo, mesmo padrão do `server`), só para `layout.ts`: `cellRects` dos cinco presets (soma das áreas, gaps, ordem das células); redutor (assign com aba em outra célula move o foco; assignTo tira a aba da célula anterior; setPreset descarta excedente e clampa foco; closeTab limpa célula e floating; detach só simulador; dock coloca na focada); `sanitize` (ids inexistentes, preset inválido, janela fora da área); `initialFloatingRect` e `clampFloating`.
- Manual (roteiro no plano): cada preset com terminais reais; mover aba entre células sem o terminal piscar ou perder o prompt; destacar/arrastar/redimensionar o simulador com o stream rodando; sair e voltar da seção; recarregar a página e ver o layout igual; atalhos ⌘1-9/⌘T/⌘W; preset `single` idêntico ao comportamento atual.
