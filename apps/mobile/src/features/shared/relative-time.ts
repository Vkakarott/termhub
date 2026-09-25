function twoDigits(value: number): string {
  return String(value).padStart(2, '0');
}

/**
 * The notifications and chat relative timestamp: "agora" under a minute, "há N min" under an
 * hour, "há N h" under a day, "ontem" for the previous day, and "DD/MM" for anything older.
 */
export function relativeTime(iso: string, now: number): string {
  const at = new Date(iso);
  const minutes = Math.floor((now - at.getTime()) / 60_000);
  if (minutes < 1) return 'agora';
  if (minutes < 60) return `há ${minutes} min`;

  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `há ${hours} h`;

  const days = Math.floor(hours / 24);
  if (days === 1) return 'ontem';

  return `${twoDigits(at.getDate())}/${twoDigits(at.getMonth() + 1)}`;
}
