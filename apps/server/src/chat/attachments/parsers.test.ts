import ExcelJS from 'exceljs';
import { describe, expect, it, vi } from 'vitest';
import { withUnlistedEntry } from '../../../test/zip.js';
import { ExtractError } from './errors.js';
import { ZIP_EXPANDED_MAX_BYTES, parseDocument } from './parsers.js';

/**
 * In-thread: spies on exceljs only see the thread they run in, so what they assert (which reader
 * ran) is tested here, against the parsers themselves. `extract.test.ts` covers the same parsers
 * through the worker.
 */
const code = async (p: Promise<unknown>): Promise<string> => {
  try {
    await p;
    return 'resolved';
  } catch (err) {
    return err instanceof ExtractError ? err.code : `other:${String(err)}`;
  }
};

describe('parseDocument (in-thread)', () => {
  it('xlsx: a local entry the directory does not list is refused before the streaming reader (which walks local headers) sees it', async () => {
    const wb = new ExcelJS.Workbook();
    wb.addWorksheet('S').addRow(['x']);
    const genuine = Buffer.from(await wb.xlsx.writeBuffer());
    const strings = `<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">${'<si><t>aaaaaaaaaaaaaaaa</t></si>'.repeat(40_000)}</sst>`;
    const hidden = withUnlistedEntry(genuine, 'xl/sharedStrings.xml', strings);
    expect(hidden.length).toBeLessThan(genuine.length + 16 * 1024);
    const parse = vi.spyOn(ExcelJS.stream.xlsx.WorkbookReader.prototype, 'parse');
    try {
      expect(await code(parseDocument('xlsx', hidden, 256 * 1024))).toBe('ATTACHMENT_INVALID');
      expect(parse).not.toHaveBeenCalled();
      expect((await parseDocument('xlsx', genuine, 256 * 1024)).meta).toMatchObject({ sheets: [{ name: 'S', rows: 1, cols: 1 }] });
    } finally {
      parse.mockRestore();
    }
  });

  it('xlsx: read through the streaming WorkbookReader, one row at a time, never a whole-workbook load', async () => {
    const streamed = vi.spyOn(ExcelJS.stream.xlsx.WorkbookReader.prototype, 'parse');
    const loaded = vi.spyOn(Object.getPrototypeOf(new ExcelJS.Workbook().xlsx) as ExcelJS.Xlsx, 'load');
    try {
      const wb = new ExcelJS.Workbook();
      const ws = wb.addWorksheet('Gaps');
      ws.getRow(1).values = ['a', 'b'];
      ws.getRow(3).values = ['c'];
      const r = await parseDocument('xlsx', Buffer.from(await wb.xlsx.writeBuffer()), ZIP_EXPANDED_MAX_BYTES);
      expect(streamed).toHaveBeenCalledTimes(1);
      expect(loaded).not.toHaveBeenCalled();
      expect(r.text).toBe('## Gaps\n| a | b |\n| --- | --- |\n|  |  |\n| c |  |');
      expect(r.meta).toEqual({ sheets: [{ name: 'Gaps', rows: 3, cols: 2 }], truncated: false });
    } finally {
      streamed.mockRestore();
      loaded.mockRestore();
    }
  });
});
