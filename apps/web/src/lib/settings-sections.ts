/** Settings tabs and the resource that unlocks each. The sidebar shows "Configurações" when any is visible. */
export type SettingsSection = 'users' | 'roles' | 'permissions' | 'uploads' | 'api-tokens';

export const SETTINGS_SECTIONS: { key: SettingsSection; label: string; resource: string }[] = [
  { key: 'users', label: 'Usuários', resource: 'users' },
  { key: 'roles', label: 'Roles', resource: 'roles' },
  { key: 'permissions', label: 'Permissões', resource: 'roles' },
  { key: 'uploads', label: 'Arquivos', resource: 'uploads' },
  { key: 'api-tokens', label: 'Tokens de API', resource: 'api_tokens' },
];

export function canSeeSettings(can: (resource: string) => boolean): boolean {
  return SETTINGS_SECTIONS.some((s) => can(s.resource));
}
