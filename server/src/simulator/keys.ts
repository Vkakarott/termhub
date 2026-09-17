/** Nome de tecla do navegador (KeyboardEvent.key) → código WebDriver aceito por `POST /wda/keys`. */
const SPECIAL: Record<string, string> = {
  Enter: '',
  Backspace: '',
  Tab: '',
  Escape: '',
  Delete: '',
  ArrowLeft: '',
  ArrowUp: '',
  ArrowRight: '',
  ArrowDown: '',
};

export const SPECIAL_KEY_NAMES: readonly string[] = Object.keys(SPECIAL);

export function specialKeyToWda(name: string): string | null {
  return Object.prototype.hasOwnProperty.call(SPECIAL, name) ? SPECIAL[name] : null;
}
