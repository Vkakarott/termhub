/** Nome de tecla do navegador (KeyboardEvent.key) → código WebDriver aceito por `POST /wda/keys`. */
const SPECIAL: Record<string, string> = {
  Enter: '\uE007',
  Backspace: '\uE003',
  Tab: '\uE004',
  Escape: '\uE00C',
  Delete: '\uE017',
  ArrowLeft: '\uE012',
  ArrowUp: '\uE013',
  ArrowRight: '\uE014',
  ArrowDown: '\uE015',
};

export const SPECIAL_KEY_NAMES: readonly string[] = Object.keys(SPECIAL);

export function specialKeyToWda(name: string): string | null {
  return Object.prototype.hasOwnProperty.call(SPECIAL, name) ? SPECIAL[name] : null;
}
