/**
 * Getting a file out of the page (spec 2026-09-23 §2.6): the native share sheet where it accepts
 * the file (on a phone, Instagram is in it), a download everywhere else. Closing the sheet is the
 * person's answer, not a failure: nothing is downloaded behind their back.
 */
export type Delivery = 'shared' | 'dismissed' | 'downloaded';

export function canShareFile(file: File): boolean {
  try {
    return typeof navigator.share === 'function' && typeof navigator.canShare === 'function' && navigator.canShare({ files: [file] });
  } catch {
    return false;
  }
}

export function downloadFile(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
  // long enough for the browser to start reading it
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

export async function shareOrDownload(file: File): Promise<Delivery> {
  if (!canShareFile(file)) {
    downloadFile(file, file.name);
    return 'downloaded';
  }
  try {
    await navigator.share({ files: [file] });
    return 'shared';
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') return 'dismissed';
    downloadFile(file, file.name);
    return 'downloaded';
  }
}
