import { useState, type FormEvent } from 'react';
import { useAuth } from '../lib/auth';
import { ApiError } from '../lib/api';
import { PUBLIC_CITY_BASE } from '../lib/types';
import { Modal } from './Modal';

/**
 * The same small rules the server enforces (apps/server/src/public/nickname.ts), copied here on
 * purpose: two constants kept in sync by hand, not a shared package for them. Refusing a reserved
 * word or a bad shape here saves a round trip; the server re-checks them regardless.
 */
const RESERVED_NICKNAMES = ['city', 'api', 'ws', 'mcp', 'admin', 'www', 'static', 'assets', 'health', 'login', 'office'] as const;
const SHAPE = /^[a-z0-9]([a-z0-9-]{1,28})[a-z0-9]$/;

function checkNickname(input: string): { ok: true; value: string } | { ok: false; message: string } {
  const value = input.trim().toLowerCase();
  // Reserved words are checked before the shape, exactly like the server: 'ws' is too short to ever
  // pass the shape check, yet it must still be refused as reserved, not as a bad shape.
  if ((RESERVED_NICKNAMES as readonly string[]).includes(value)) return { ok: false, message: 'Esse apelido é reservado' };
  if (!SHAPE.test(value)) return { ok: false, message: 'Use de 3 a 30 letras, números ou hífen' };
  return { ok: true, value };
}

interface Props {
  open: boolean;
  onClose: () => void;
  /** called right after the nickname is claimed, with the value that was saved */
  onSaved?: (nickname: string) => void;
}

/**
 * Claims the address of the signed-in user's public city. Shown from two places (same component
 * both times): when a signed-in account has no nickname yet, and when a publish attempt comes back
 * `NICKNAME_REQUIRED`.
 */
export function NicknameDialog({ open, onClose, onSaved }: Props) {
  const { user, setNickname } = useAuth();
  const [value, setValue] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const preview = value.trim().toLowerCase();

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const checked = checkNickname(value);
    if (!checked.ok) {
      setError(checked.message);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await setNickname(checked.value);
      onSaved?.(checked.value);
      onClose();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Erro ao salvar apelido');
    } finally {
      setBusy(false);
    }
  };

  // The server never changes a nickname once set (409 NICKNAME_LOCKED): an address already shared
  // must keep pointing at the same person. So an account that has one only gets to see it.
  if (user?.nickname) {
    return (
      <Modal title="Seu apelido" open={open} onClose={onClose} width="max-w-sm">
        <div className="space-y-3">
          <p className="text-sm text-fg-muted">É o endereço da sua cidade pública e não pode ser trocado.</p>
          <p className="text-sm font-medium">
            {PUBLIC_CITY_BASE.replace(/^https?:\/\//, '')}/@{user.nickname}
          </p>
          <div className="flex justify-end pt-2">
            <button type="button" className="btn-ghost" onClick={onClose}>
              Fechar
            </button>
          </div>
        </div>
      </Modal>
    );
  }

  return (
    <Modal title="Escolha seu apelido" open={open} onClose={onClose} width="max-w-sm">
      <form onSubmit={submit} className="space-y-3">
        <p className="text-sm text-fg-muted">É o endereço da sua cidade pública, para quem tiver o link.</p>
        <div>
          <label className="label" htmlFor="nickname-dialog-input">
            Apelido
          </label>
          <input
            id="nickname-dialog-input"
            className="input"
            value={value}
            onChange={(e) => {
              setValue(e.target.value);
              setError(null);
            }}
            autoFocus
            required
          />
          <p className="mt-1 text-xs text-fg-dim">
            {PUBLIC_CITY_BASE.replace(/^https?:\/\//, '')}/@{preview || '…'}
          </p>
        </div>
        {error && <p className="text-sm text-danger">{error}</p>}
        <div className="flex justify-end gap-2 pt-2">
          <button type="button" className="btn-ghost" onClick={onClose}>
            Cancelar
          </button>
          <button type="submit" className="btn-primary" disabled={busy || !value.trim()}>
            {busy ? 'Salvando…' : 'Salvar'}
          </button>
        </div>
      </form>
    </Modal>
  );
}
