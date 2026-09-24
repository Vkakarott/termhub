import { useState } from 'react';
import { useLocation } from 'react-router-dom';
import { useAuth } from '../lib/auth';
import { NicknameDialog } from './NicknameDialog';

const dismissedKey = (userId: string) => `termhub:nickname-prompt-dismissed:${userId}`;

function wasDismissed(userId: string): boolean {
  try {
    return localStorage.getItem(dismissedKey(userId)) === '1';
  } catch {
    return false;
  }
}

function rememberDismissed(userId: string): void {
  try {
    localStorage.setItem(dismissedKey(userId), '1');
  } catch {
    // storage refused (private window, blocked site data): the prompt just may come back next load
  }
}

/**
 * Asks a signed-in account with no nickname for one, the first time (spec §4: the nickname is asked
 * at sign-up). Dismissible, and remembered per account in this browser once dismissed: publishing
 * asks again anyway (ProjectPage's publish switch), so declining here costs nothing later. Never
 * opens over Início, which carries the same suggestion in its checklist.
 */
export function NicknamePrompt() {
  const { user } = useAuth();
  const { pathname } = useLocation();
  const [closedFor, setClosedFor] = useState<string | null>(null);
  // Início suggests the nickname itself, in its "Próximos passos" card: not over it too
  const open = pathname !== '/' && !!user && !user.nickname && closedFor !== user.id && !wasDismissed(user.id);
  if (!user || !open) return null;
  return (
    <NicknameDialog
      open
      onClose={() => {
        rememberDismissed(user.id);
        setClosedFor(user.id);
      }}
      onSaved={() => setClosedFor(user.id)}
    />
  );
}
