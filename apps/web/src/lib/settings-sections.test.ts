import { describe, expect, it } from 'vitest';
import { canSeeSettings, SETTINGS_SECTIONS, visibleSettingsSections } from './settings-sections';

describe('settings sections', () => {
  it('shows Settings to a user whose only grant is api_tokens', () => {
    expect(canSeeSettings((r) => r === 'api_tokens')).toBe(true);
  });

  it('shows Settings to a user without any settings grant, for the Minha cidade tab', () => {
    expect(canSeeSettings(() => false)).toBe(true);
    expect(visibleSettingsSections(() => false).map((s) => s.key)).toEqual(['city']);
  });

  it('keeps the other tabs gated by their resource', () => {
    expect(visibleSettingsSections((r) => r === 'api_tokens').map((s) => s.key)).toEqual(['api-tokens', 'city']);
  });

  it('keeps Usuários as the first tab an admin lands on', () => {
    expect(visibleSettingsSections(() => true)[0]?.key).toBe('users');
  });

  it('has a Tokens de API tab guarded by api_tokens', () => {
    expect(SETTINGS_SECTIONS.find((s) => s.key === 'api-tokens')).toEqual({ key: 'api-tokens', label: 'Tokens de API', resource: 'api_tokens' });
  });

  it('has a Minha cidade tab with no resource', () => {
    expect(SETTINGS_SECTIONS.find((s) => s.key === 'city')).toEqual({ key: 'city', label: 'Minha cidade', resource: null });
  });
});
