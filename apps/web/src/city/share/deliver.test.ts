// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { canShareFile, shareOrDownload } from './deliver';

const file = () => new File(['x'], 'termhub-cidade-pedro-story.png', { type: 'image/png' });
let clicked: HTMLAnchorElement[] = [];

function shareSheet(opts: { canShare: boolean; share?: () => Promise<void> }) {
  Object.defineProperty(navigator, 'canShare', { configurable: true, value: vi.fn(() => opts.canShare) });
  Object.defineProperty(navigator, 'share', { configurable: true, value: vi.fn(opts.share ?? (async () => {})) });
}

beforeEach(() => {
  clicked = [];
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
    clicked.push(this);
  });
  Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: vi.fn(() => 'blob:file') });
  Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: vi.fn() });
});

afterEach(() => {
  vi.restoreAllMocks();
  Object.defineProperty(navigator, 'canShare', { configurable: true, value: undefined });
  Object.defineProperty(navigator, 'share', { configurable: true, value: undefined });
});

describe('delivery', () => {
  it('opens the share sheet where it accepts the file', async () => {
    shareSheet({ canShare: true });
    expect(canShareFile(file())).toBe(true);
    expect(await shareOrDownload(file())).toBe('shared');
    expect(navigator.share).toHaveBeenCalledWith({ files: [expect.any(File)] });
    expect(clicked).toHaveLength(0);
  });

  it('downloads where there is no share sheet, or it refuses files', async () => {
    expect(canShareFile(file())).toBe(false);
    expect(await shareOrDownload(file())).toBe('downloaded');
    shareSheet({ canShare: false });
    expect(await shareOrDownload(file())).toBe('downloaded');
    expect(clicked.map((a) => a.download)).toEqual(['termhub-cidade-pedro-story.png', 'termhub-cidade-pedro-story.png']);
  });

  // Review Focus 4
  it('does nothing more when the person closes the share sheet', async () => {
    shareSheet({ canShare: true, share: async () => { throw new DOMException('closed', 'AbortError'); } });
    expect(await shareOrDownload(file())).toBe('dismissed');
    expect(clicked).toHaveLength(0);
  });

  it('falls back to a download when the share sheet rejects the file', async () => {
    shareSheet({ canShare: true, share: async () => { throw new DOMException('no', 'NotAllowedError'); } });
    expect(await shareOrDownload(file())).toBe('downloaded');
    expect(clicked).toHaveLength(1);
  });

  it('treats a canShare that throws as no share sheet', () => {
    Object.defineProperty(navigator, 'canShare', { configurable: true, value: () => { throw new TypeError('bad'); } });
    Object.defineProperty(navigator, 'share', { configurable: true, value: vi.fn() });
    expect(canShareFile(file())).toBe(false);
  });
});
