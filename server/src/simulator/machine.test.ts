import { describe, expect, it } from 'vitest';
import { isBootFailure, parseSimctlList } from './machine.js';

const sample = JSON.stringify({
  devices: {
    'com.apple.CoreSimulator.SimRuntime.iOS-26-3': [
      { udid: 'AAA', name: 'iPhone 16e', state: 'Booted', isAvailable: true },
      { udid: 'BBB', name: 'iPad mini', state: 'Shutdown', isAvailable: true },
      { udid: 'CCC', name: 'Quebrado', state: 'Shutdown', isAvailable: false },
    ],
    'com.apple.CoreSimulator.SimRuntime.iOS-16-4': [],
  },
});

describe('parseSimctlList', () => {
  it('extrai runtime legível, ignora indisponíveis e põe bootados primeiro', () => {
    expect(parseSimctlList(sample)).toEqual([
      { udid: 'AAA', name: 'iPhone 16e', runtime: 'iOS 26.3', state: 'Booted' },
      { udid: 'BBB', name: 'iPad mini', runtime: 'iOS 26.3', state: 'Shutdown' },
    ]);
  });

  it('JSON inválido devolve lista vazia', () => {
    expect(parseSimctlList('nope')).toEqual([]);
  });
});

describe('isBootFailure', () => {
  it('saída vazia não é falha', () => {
    expect(isBootFailure('')).toBe(false);
  });

  it('já bootado ("current state: Booted") não é falha', () => {
    expect(isBootFailure('Unable to boot device in current state: Booted')).toBe(false);
  });

  it('"current state: Shutting Down" é falha', () => {
    expect(isBootFailure('Unable to boot device in current state: Shutting Down')).toBe(true);
  });

  it('"Invalid device" é falha', () => {
    expect(isBootFailure('Invalid device: XYZ')).toBe(true);
  });
});
