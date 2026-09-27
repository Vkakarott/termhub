import { expect, it } from 'vitest';
import { compactDoneText, compactFailedText, contextLevel, contextShare, contextTitle, formatShare, formatTokens, isCompactCommand, isCompactShortcut } from './chat-context';

it('the share is capped at the window, and unknown without one', () => {
  expect(contextShare(50_000, 200_000)).toBe(0.25);
  expect(contextShare(250_000, 200_000)).toBe(1);
  expect(contextShare(10, null)).toBeNull();
  expect(contextShare(10, 0)).toBeNull();
});

it('is highlighted from 80% and red from 95%', () => {
  expect(contextLevel(0.79)).toBe('ok');
  expect(contextLevel(0.8)).toBe('warn');
  expect(contextLevel(0.949)).toBe('warn');
  expect(contextLevel(0.95)).toBe('full');
  expect(contextLevel(null)).toBe('ok');
});

it('writes token counts short, in pt-BR', () => {
  expect(formatTokens(950)).toBe('950');
  expect(formatTokens(1_951)).toBe('2 mil');
  expect(formatTokens(25_258)).toBe('25 mil');
  expect(formatTokens(1_500)).toBe('1,5 mil');
  expect(formatTokens(1_000_000)).toBe('1 mi');
  expect(formatTokens(200_000)).toBe('200 mil');
});

it('never says 0% of a context that has something in it', () => {
  expect(formatShare(0.004)).toBe('<1%');
  expect(formatShare(0)).toBe('0%');
  expect(formatShare(0.826)).toBe('83%');
});

it('the tooltip has the exact numbers, and suggests compacting once high', () => {
  expect(contextTitle(25_258, 1_000_000)).toBe('Contexto da conversa: 25.258 de 1.000.000 tokens (3%)');
  expect(contextTitle(170_000, 200_000)).toBe('Contexto da conversa: 170.000 de 200.000 tokens (85%). Compacte a conversa para liberar espaço.');
  expect(contextTitle(1_200, null)).toBe('Contexto da conversa: 1.200 tokens');
});

it('says what a compaction did, or why it did not', () => {
  expect(compactDoneText(150_000, 12_000)).toBe('Conversa compactada: 150 mil → 12 mil tokens');
  expect(compactDoneText(null, null)).toBe('Conversa compactada');
  expect(compactFailedText('MISSING_SESSION')).toMatch(/não existe mais/);
  expect(compactFailedText('RUNNER_FAILED')).toBe('Não foi possível compactar a conversa');
  expect(compactFailedText(null)).toBe('Não foi possível compactar a conversa');
});

it('Alt+Shift+C by the physical key, and nothing with Ctrl or ⌘', () => {
  const k = (over: Partial<KeyboardEvent>) => ({ code: 'KeyC', altKey: true, shiftKey: true, ctrlKey: false, metaKey: false, ...over });
  expect(isCompactShortcut(k({}))).toBe(true);
  expect(isCompactShortcut(k({ shiftKey: false }))).toBe(false);
  expect(isCompactShortcut(k({ ctrlKey: true }))).toBe(false);
  expect(isCompactShortcut(k({ metaKey: true }))).toBe(false);
  expect(isCompactShortcut(k({ code: 'KeyV' }))).toBe(false);
});

it('/compact alone is the command; with anything else it is a message', () => {
  expect(isCompactCommand(' /compact ')).toBe(true);
  expect(isCompactCommand('/compact agora')).toBe(false);
  expect(isCompactCommand('compact')).toBe(false);
});
