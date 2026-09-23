import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS_SECTION, SETTINGS_SECTIONS, settingsGroups, visibleSettingsSections } from './settings-sections';

const keysOf = (groups: ReturnType<typeof settingsGroups>) => groups.map((g) => [g.label, g.sections.map((s) => s.key)]);

describe('settings sections', () => {
  it('lists Conta, then Administração, in the settings sidebar order', () => {
    expect(SETTINGS_SECTIONS.map((s) => `${s.group}:${s.key}`)).toEqual([
      'account:profile',
      'account:city',
      'account:integrations',
      'account:api-tokens',
      'admin:users',
      'admin:roles',
      'admin:permissions',
      'admin:uploads',
    ]);
  });

  it('opens on Perfil, which every signed-in user sees', () => {
    expect(DEFAULT_SETTINGS_SECTION).toBe('profile');
    expect(SETTINGS_SECTIONS.find((s) => s.key === 'profile')).toEqual({ key: 'profile', label: 'Perfil', resource: null, group: 'account' });
    expect(visibleSettingsSections(() => false).map((s) => s.key)).toEqual(['profile', 'city']);
    expect(visibleSettingsSections(() => true)[0]?.key).toBe('profile');
  });

  it('gates Integrações and Tokens de API by their resource', () => {
    expect(SETTINGS_SECTIONS.find((s) => s.key === 'integrations')).toEqual({ key: 'integrations', label: 'Integrações', resource: 'integrations', group: 'account' });
    expect(visibleSettingsSections((r) => r === 'api_tokens').map((s) => s.key)).toEqual(['profile', 'city', 'api-tokens']);
    expect(visibleSettingsSections((r) => r === 'integrations').map((s) => s.key)).toEqual(['profile', 'city', 'integrations']);
  });

  it('keeps the admin sections under their current resources', () => {
    expect(visibleSettingsSections((r) => r === 'roles').map((s) => s.key)).toEqual(['profile', 'city', 'roles', 'permissions']);
    expect(visibleSettingsSections((r) => r === 'users').map((s) => s.key)).toEqual(['profile', 'city', 'users']);
  });

  it('leaves Administração out when nothing in it is visible', () => {
    expect(keysOf(settingsGroups(() => false))).toEqual([['Conta', ['profile', 'city']]]);
    expect(keysOf(settingsGroups((r) => r === 'uploads'))).toEqual([
      ['Conta', ['profile', 'city']],
      ['Administração', ['uploads']],
    ]);
  });
});
