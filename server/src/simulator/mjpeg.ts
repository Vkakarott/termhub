const HEADER_END = Buffer.from('\r\n\r\n');
/** Limite de segurança: se acumular isso sem achar um cabeçalho, o stream está corrompido. */
const MAX_BUFFER = 32 * 1024 * 1024;

/**
 * Parser do multipart/x-mixed-replace que o WDA emite:
 * `--BoundaryString\r\nContent-type: image/jpeg\r\nContent-Length: N\r\n\r\n<N bytes>\r\n`.
 * Sem dependências; funciona com chunks de qualquer tamanho.
 */
export class MjpegParser {
  private buf: Buffer = Buffer.alloc(0);

  push(chunk: Buffer): Buffer[] {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    const frames: Buffer[] = [];
    for (;;) {
      const headerEnd = this.buf.indexOf(HEADER_END);
      if (headerEnd === -1) {
        if (this.buf.length > MAX_BUFFER) this.buf = Buffer.alloc(0);
        break;
      }
      const header = this.buf.subarray(0, headerEnd).toString('latin1');
      const m = /content-length:\s*(\d+)/i.exec(header);
      const start = headerEnd + HEADER_END.length;
      if (!m) {
        // Parte sem tamanho: pula o cabeçalho e segue procurando o próximo.
        this.buf = this.buf.subarray(start);
        continue;
      }
      const len = Number(m[1]);
      if (this.buf.length < start + len) break;
      frames.push(Buffer.from(this.buf.subarray(start, start + len)));
      this.buf = this.buf.subarray(start + len);
    }
    if (frames.length && this.buf.length === 0) this.buf = Buffer.alloc(0);
    return frames;
  }
}
