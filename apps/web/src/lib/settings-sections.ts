/**
 * Settings tabs and the resource that unlocks each; `resource: null` is a tab every signed-in user
 * sees (Minha cidade: each account's own public city), so "Configurações" always shows in the sidebar.
 * The first visible tab is where `/settings` lands, so the unconditional one goes last: an admin still
 * lands on Usuários, and an account with no settings grant lands on Minha cidade.
 */
export type SettingsSection = 'users' | 'roles' | 'permissions' | 'uploads' | 'api-tokens' | 'city';

export const SETTINGS_SECTIONS: { key: SettingsSection; label: string; resource: string | null }[] = [
  { key: 'users', label: 'Usuários', resource: 'users' },
  { key: 'roles', label: 'Roles', resource: 'roles' },
  { key: 'permissions', label: 'Permissões', resource: 'roles' },
  { key: 'uploads', label: 'Arquivos', resource: 'uploads' },
  { key: 'api-tokens', label: 'Tokens de API', resource: 'api_tokens' },
  { key: 'city', label: 'Minha cidade', resource: null },
];

export function visibleSettingsSections(can: (resource: string) => boolean): typeof SETTINGS_SECTIONS {
  return SETTINGS_SECTIONS.filter((s) => s.resource === null || can(s.resource));
}

export function canSeeSettings(can: (resource: string) => boolean): boolean {
  return visibleSettingsSections(can).length > 0;
}
