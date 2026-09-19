import { describe, expect, it } from 'vitest';
import { canSeeSettings, SETTINGS_SECTIONS } from './settings-sections';

describe('settings sections', () => {
  it('shows Settings to a user whose only grant is api_tokens', () => {
    expect(canSeeSettings((r) => r === 'api_tokens')).toBe(true);
  });

  it('hides Settings without any settings grant', () => {
    expect(canSeeSettings((r) => r === 'machines')).toBe(false);
  });

  it('has a Tokens de API tab guarded by api_tokens', () => {
    expect(SETTINGS_SECTIONS.find((s) => s.key === 'api-tokens')).toEqual({ key: 'api-tokens', label: 'Tokens de API', resource: 'api_tokens' });
  });
});
