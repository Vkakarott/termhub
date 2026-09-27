/**
 * A deterministic floor under the concierge's judgement (spec D7): a card whose header, question or
 * chosen labels name an irreversible act is never answered automatically, only suggested. Crude on
 * purpose — it cannot tell "não fazer deploy" from "fazer deploy", and that is the safe direction.
 */
const STEMS = [
  'deploy',
  'producao',
  'production',
  'prod',
  'push',
  'merge',
  'delete',
  'deletar',
  'apagar',
  'remover',
  'remove',
  'excluir',
  'drop',
  'reset',
  'force',
  'rm',
  'publicar',
  'publish',
  'release',
  'pagar',
  'pay',
  'destroy',
  'destruir',
];

/**
 * Extract words from text, removing accents and normalizing to lowercase.
 */
const words = (s: string): string[] =>
  s
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);

/**
 * Check if the parts contain any blocked terms that indicate an irreversible action.
 * Returns true if the action should be blocked from automatic answering.
 */
export function autoAnswerBlocked(parts: string[]): boolean {
  return parts.some((p) =>
    words(p).some((w) => STEMS.some((s) => w === s || (s.length >= 5 && w.startsWith(s)))),
  );
}
