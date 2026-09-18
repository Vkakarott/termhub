import { randomBytes } from 'node:crypto';
import type { Machine } from '../db/repositories/types.js';
import { HttpError, badRequest } from '../lib/errors.js';
import { runOnMachineWithInput } from './machine-exec.js';

export const PASTE_MAX_BYTES = 20 * 1024 * 1024;
/** Directory (relative to $HOME on the target machine) where pasted/dropped files go. */
export const PASTE_DIR = '.cache/termhub/paste';
/** Files older than this are deleted on every new upload. */
const KEEP_DAYS = 7;

const EXT_BY_MIME: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
};

/** Image signature check: images get a canonical extension regardless of the client's name. */
function sniffImage(buf: Buffer): string | null {
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
    .replace(/[\u0300-\u036f]/g, '')
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

export interface PastedFile {
  /** absolute path on the target machine */
  path: string;
  /** file name inside PASTE_DIR */
  name: string;
  bytes: number;
  mime: string;
}

/** Writes the file to ~/.cache/termhub/paste/ on the machine and returns its absolute path. */
export async function saveFileOnMachine(machine: Machine, data: Buffer, originalName?: string | null): Promise<PastedFile> {
  if (data.length === 0) throw badRequest('Arquivo vazio');
  if (data.length > PASTE_MAX_BYTES) throw new HttpError(413, 'Arquivo maior que 20 MB');
  const imageMime = sniffImage(data);
  // images get a canonical extension from the signature; anything else keeps its (sanitized) name
  const name = safeName(imageMime ? originalName || `image.${EXT_BY_MIME[imageMime]}` : originalName, imageMime ? EXT_BY_MIME[imageMime] : null);
  const mime = imageMime ?? 'application/octet-stream';

  // Name is sanitized above (no quotes, spaces or slashes) and PASTE_DIR is fixed: nothing raw from the client enters the command.
  const script = [
    `d="$HOME/${PASTE_DIR}"`,
    `mkdir -p "$d" || exit 1`,
    `cat > "$d/${name}" || exit 1`,
    `find "$d" -name 'paste-*' -type f -mtime +${KEEP_DAYS} -delete 2>/dev/null`,
    `printf '%s\\n' "$d/${name}"`,
  ].join('; ');

  const r = await runOnMachineWithInput(machine, { file: '/bin/sh', args: ['-c', script] }, script, data);
  if (r.timedOut) throw new HttpError(504, 'A máquina demorou para receber o arquivo');
  if (r.code !== 0) throw new HttpError(502, machine.type === 'ssh' ? 'Falha ao enviar o arquivo via SSH' : 'Falha ao gravar o arquivo');
  const path = r.stdout.trim().split('\n').pop() ?? '';
  if (!path.startsWith('/')) throw new HttpError(502, 'Resposta inesperada da máquina');
  return { path, name, bytes: data.length, mime };
}
