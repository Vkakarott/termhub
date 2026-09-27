import { describe, expect, it } from 'vitest';
import { autoAnswerBlocked } from './blocklist.js';

describe('autoAnswerBlocked', () => {
  it.each([
    ['Fazer deploy em produção?'],
    ['Push para a main?'],
    ['Fazer merge do PR?'],
    ['Apagar o worktree?'],
    ['Delete the branch?'],
    ['git push --force?'],
    ['Rodar rm -rf dist?'],
    ['Publicar no npm?'],
    ['Remover a migração?'],
    ['Confirmar exclusão do card?'],
    ['Remoção do worktree?'],
    ['Pushing now?'],
    ['Merged into main?'],
    ['Publicado?'],
  ])('blocks %s', (q) => expect(autoAnswerBlocked(['Ação', q, 'Sim'])).toBe(true));

  it.each([
    ['Usar git worktree para isolar o trabalho?'],
    ['Seguir com TDD?'],
    ['Onde salvar o spec?'],
    ['Qual abordagem?'],
    ['Qual produto usar?'],
    ['Essa rota é pública?'],
    ['Isso é exclusivo do admin?'],
    ['Houve um apagão?'],
    ['Precisamos destravar esse bloqueio?'],
  ])('allows %s', (q) => expect(autoAnswerBlocked(['Plano', q, 'Sim'])).toBe(false));

  it('checks the chosen labels too', () =>
    expect(autoAnswerBlocked(['Próximo passo', 'O que fazer?', 'Deploy agora'])).toBe(true));

  it('ignores accents and case', () => expect(autoAnswerBlocked(['PRODUCAO'])).toBe(true));
});
