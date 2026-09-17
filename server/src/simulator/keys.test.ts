import { describe, expect, it } from 'vitest';
import { SPECIAL_KEY_NAMES, specialKeyToWda } from './keys.js';

describe('specialKeyToWda', () => {
  it('mapeia as teclas de controle para os códigos W3C', () => {
    expect(specialKeyToWda('Enter')).toBe('');
    expect(specialKeyToWda('Backspace')).toBe('');
    expect(specialKeyToWda('Tab')).toBe('');
    expect(specialKeyToWda('Escape')).toBe('');
    expect(specialKeyToWda('Delete')).toBe('');
    expect(specialKeyToWda('ArrowLeft')).toBe('');
    expect(specialKeyToWda('ArrowUp')).toBe('');
    expect(specialKeyToWda('ArrowRight')).toBe('');
    expect(specialKeyToWda('ArrowDown')).toBe('');
  });

  it('desconhecida devolve null', () => {
    expect(specialKeyToWda('F5')).toBeNull();
    expect(specialKeyToWda('a')).toBeNull();
  });

  it('SPECIAL_KEY_NAMES lista exatamente as teclas mapeadas', () => {
    for (const n of SPECIAL_KEY_NAMES) expect(specialKeyToWda(n)).not.toBeNull();
    expect(SPECIAL_KEY_NAMES).toContain('Enter');
  });
});
