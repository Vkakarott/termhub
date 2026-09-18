import { describe, expect, it } from 'vitest';
import { SPECIAL_KEY_NAMES, specialKeyToWda } from './keys.js';

describe('specialKeyToWda', () => {
  it('mapeia as teclas de controle para os códigos W3C', () => {
    expect(specialKeyToWda('Enter')).toBe('\uE007');
    expect(specialKeyToWda('Backspace')).toBe('\uE003');
    expect(specialKeyToWda('Tab')).toBe('\uE004');
    expect(specialKeyToWda('Escape')).toBe('\uE00C');
    expect(specialKeyToWda('Delete')).toBe('\uE017');
    expect(specialKeyToWda('ArrowLeft')).toBe('\uE012');
    expect(specialKeyToWda('ArrowUp')).toBe('\uE013');
    expect(specialKeyToWda('ArrowRight')).toBe('\uE014');
    expect(specialKeyToWda('ArrowDown')).toBe('\uE015');
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
