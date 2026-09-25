import { describe, expect, it } from 'vitest';
import { isResource, RESOURCES } from './permissions.js';
describe('resource catalog', () => {
  it('knows the devices resource, labelled in pt-BR', () => {
    expect(isResource('devices')).toBe(true);
    expect(RESOURCES.find((r) => r.key === 'devices')?.label).toBe('Aparelhos');
  });
});
