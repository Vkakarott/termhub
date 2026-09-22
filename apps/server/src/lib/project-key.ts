/** Project key: 2–10 uppercase letters/digits, starting with a letter (TERMHUB, HC, A1). */
export const PROJECT_KEY_RE = /^[A-Z][A-Z0-9]{1,9}$/;

export const PROJECT_KEY_MAX = 10;

export function isValidProjectKey(key: string): boolean {
  return PROJECT_KEY_RE.test(key);
}

/** ASCII letters and digits of a name, accents stripped ("Ação" → "Acao"), everything else → space. */
function words(name: string): string[] {
  return name
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^A-Za-z0-9]+/g, ' ')
    .trim()
    .split(' ')
    .filter(Boolean);
}

/**
 * A key suggestion from a project name: initials of a multi-word name, the first three characters
 * of a single word, uppercased; `P` in front when it would start with a digit; never longer than 10.
 * Falls back to `PRJ` when nothing usable is left. The result is always a valid key.
 */
export function suggestProjectKey(name: string): string {
  const ws = words(name);
  let base = ws.length > 1 ? ws.map((w) => w[0]).join('') : (ws[0] ?? '').slice(0, 3);
  base = base.toUpperCase().slice(0, PROJECT_KEY_MAX);
  if (/^[0-9]/.test(base)) base = ('P' + base).slice(0, PROJECT_KEY_MAX);
  return isValidProjectKey(base) ? base : 'PRJ';
}
