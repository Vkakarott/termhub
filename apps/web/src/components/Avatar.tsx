import type { User } from '../lib/types';

/** The user's picture, or their initial on a plain disc when they have none. */
export function Avatar({ user, size }: { user: Pick<User, 'name' | 'avatar_url'> | null; size: number }) {
  const box = { width: size, height: size };
  if (user?.avatar_url) return <img src={user.avatar_url} alt="" style={box} className="shrink-0 rounded-full" referrerPolicy="no-referrer" />;
  return (
    <span aria-hidden="true" style={{ ...box, fontSize: Math.round(size * 0.45) }} className="flex shrink-0 items-center justify-center rounded-full bg-bg-4 font-semibold">
      {user?.name?.[0]?.toUpperCase() ?? '?'}
    </span>
  );
}
