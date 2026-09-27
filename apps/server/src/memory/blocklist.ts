/**
 * A deterministic floor under the concierge's judgement (spec D7): a card whose header, question or
 * chosen labels name an irreversible act is never answered automatically, only suggested. Crude on
 * purpose — it cannot tell "não fazer deploy" from "fazer deploy", and that is the safe direction.
 */
const EXACT_ONLY = new Set(['rm', 'prod', 'apaga']);
const STEMS = [
  'deploy',
  'deplo',
  'producao',
  'production',
  'prod',
  'push',
  'merge',
  'delete',
  'deletar',
  'apagar',
  'apague',
  'apagad',
  'apaga',
  'remover',
  'remov',
  'remocao',
  'remove',
  'excluir',
  'exclui',
  'exclua',
  'exclusao',
  'drop',
  'reset',
  'force',
  'rm',
  'publicar',
  'publicad',
  'publicacao',
  'publiqu',
  'publish',
  'release',
  'pagar',
  'pay',
  'destroy',
  'destrui',
  'destruct',
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
    words(p).some((w) =>
      STEMS.some((s) => {
        // Exact-only stems (rm, prod) must match exactly
        if (EXACT_ONLY.has(s)) {
          return w === s;
        }
        // Other stems match exactly or as prefix if >= 4 chars
        return w === s || (s.length >= 4 && w.startsWith(s));
      }),
    ),
  );
}
