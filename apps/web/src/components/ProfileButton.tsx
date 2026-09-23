import { Settings as SettingsIcon } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../lib/auth';
import { Avatar } from './Avatar';

/**
 * The way into Configurações (spec 2026-09-23 app chrome §3, §5): the whole profile row — avatar,
 * name, gear — is one button that opens Perfil; in the rail, just the avatar.
 */
export function ProfileButton({ variant }: { variant: 'row' | 'rail' }) {
  const { user } = useAuth();
  const navigate = useNavigate();
  const open = () => navigate('/settings/profile');

  if (variant === 'rail') {
    return (
      <button type="button" className="mb-2 shrink-0 rounded-full p-1 hover:bg-bg-3" onClick={open} aria-label="Configurações e perfil" title={user?.name ?? 'Configurações e perfil'}>
        <Avatar user={user} size={28} />
      </button>
    );
  }
  return (
    <button type="button" className="flex w-full shrink-0 items-center gap-2 border-t border-line px-3 py-2 text-left hover:bg-bg-3" onClick={open} aria-label="Configurações e perfil" title={user?.email}>
      <Avatar user={user} size={24} />
      <span className="min-w-0 flex-1 truncate text-xs text-fg-muted">{user?.name}</span>
      <SettingsIcon size={16} aria-hidden="true" className="shrink-0 text-fg-dim" />
    </button>
  );
}
