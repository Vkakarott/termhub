import { randomBytes } from 'node:crypto';

export const PASTE_MAX_BYTES = 20 * 1024 * 1024;
/** Directory (relative to $HOME on the target machine) where pasted/dropped files go. */
export const PASTE_DIR = '.cache/termhub/paste';
/** Files older than this are deleted on every new upload. */
export const PASTE_KEEP_DAYS = 7;

export const EXT_BY_MIME: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
};

/** Image signature check: images get a canonical extension regardless of the client's name. */
export function sniffImage(buf: Buffer): string | null {
  if (buf.length < 12) return null;
  if (buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  const head6 = buf.subarray(0, 6).toString('latin1');
  if (head6 === 'GIF87a' || head6 === 'GIF89a') return 'image/gif';
  if (buf.subarray(0, 4).toString('latin1') === 'RIFF' && buf.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp';
  return null;
}

function stamp(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}-${randomBytes(3).toString('hex')}`;
}

/**
 * Safe file name for the machine: only [A-Za-z0-9._-], no leading dot/dash, capped length.
 * The original name is kept (sanitized) so Claude sees "report.pdf", not a hash.
 */
export function safeName(original: string | undefined | null, ext: string | null): string {
  const base = (original ?? '').split(/[\\/]/).pop() ?? '';
  let clean = base
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^A-Za-z0-9._-]+/g, '_')
    .replace(/^[._-]+/, '')
    .replace(/_+/g, '_');
  // cap the length but keep the extension
  if (clean.length > 80) {
    const dot = clean.lastIndexOf('.');
    const tail = dot > 0 && clean.length - dot <= 12 ? clean.slice(dot) : '';
    clean = clean.slice(0, 80 - tail.length) + tail;
  }
  if (!clean || clean === '.' || clean === '..') clean = ext ? `file.${ext}` : 'file';
  if (ext && !clean.toLowerCase().endsWith(`.${ext}`)) clean = `${clean.replace(/\.[^.]*$/, '')}.${ext}`;
  return `paste-${stamp()}-${clean}`;
}

/**
 * POSIX sh that writes stdin to ~/.cache/termhub/paste/<name> on the machine, prunes files
 * older than PASTE_KEEP_DAYS and echoes the absolute path. `name` must already be sanitized
 * with safeName (no quotes, spaces or slashes): nothing raw from the client enters the script.
 */
export function buildPasteScript(name: string): string {
  return [
    `d="$HOME/${PASTE_DIR}"`,
    `mkdir -p "$d" || exit 1`,
    `cat > "$d/${name}" || exit 1`,
    `find "$d" -name 'paste-*' -type f -mtime +${PASTE_KEEP_DAYS} -delete 2>/dev/null`,
    `printf '%s\\n' "$d/${name}"`,
  ].join('; ');
}
