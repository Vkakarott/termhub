import { randomBytes } from 'node:crypto';
import type { Machine } from '../db/repositories/types.js';
import { HttpError, badRequest } from '../lib/errors.js';
import { runOnMachineWithInput } from './machine-exec.js';

export const PASTE_IMAGE_MAX_BYTES = 20 * 1024 * 1024;
/** Diretório (relativo ao $HOME da máquina de destino) onde as imagens coladas ficam. */
export const PASTE_DIR = '.cache/termhub/paste';
/** Imagens mais antigas que isso são apagadas a cada novo upload. */
const KEEP_DAYS = 7;

const EXT_BY_MIME: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
};

/** Confere a assinatura do arquivo: só gravamos na máquina o que realmente é imagem. */
function sniffImage(buf: Buffer): string | null {
  if (buf.length < 12) return null;
  if (buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  const head6 = buf.subarray(0, 6).toString('latin1');
  if (head6 === 'GIF87a' || head6 === 'GIF89a') return 'image/gif';
  if (buf.subarray(0, 4).toString('latin1') === 'RIFF' && buf.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp';
  return null;
}

function fileName(ext: string): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
  return `paste-${stamp}-${randomBytes(3).toString('hex')}.${ext}`;
}

export interface PastedImage {
  /** caminho absoluto na máquina de destino */
  path: string;
  bytes: number;
  mime: string;
}

/** Grava a imagem em ~/.cache/termhub/paste/ na máquina e devolve o caminho absoluto. */
export async function saveImageOnMachine(machine: Machine, data: Buffer): Promise<PastedImage> {
  if (data.length === 0) throw badRequest('Imagem vazia');
  if (data.length > PASTE_IMAGE_MAX_BYTES) throw new HttpError(413, 'Imagem maior que 20 MB');
  const mime = sniffImage(data);
  if (!mime) throw new HttpError(415, 'Formato não suportado (use PNG, JPEG, GIF ou WebP)');
  const name = fileName(EXT_BY_MIME[mime]);

  // Nome gerado aqui (só [a-z0-9.-]) e PASTE_DIR fixo: nada vindo do cliente entra no comando.
  const script = [
    `d="$HOME/${PASTE_DIR}"`,
    `mkdir -p "$d" || exit 1`,
    `cat > "$d/${name}" || exit 1`,
    `find "$d" -name 'paste-*' -type f -mtime +${KEEP_DAYS} -delete 2>/dev/null`,
    `printf '%s\\n' "$d/${name}"`,
  ].join('; ');

  const r = await runOnMachineWithInput(machine, { file: '/bin/sh', args: ['-c', script] }, script, data);
  if (r.timedOut) throw new HttpError(504, 'A máquina demorou para receber a imagem');
  if (r.code !== 0) throw new HttpError(502, machine.type === 'ssh' ? 'Falha ao enviar a imagem via SSH' : 'Falha ao gravar a imagem');
  const path = r.stdout.trim().split('\n').pop() ?? '';
  if (!path.startsWith('/')) throw new HttpError(502, 'Resposta inesperada da máquina');
  return { path, bytes: data.length, mime };
}
