/**
 * The attachment extraction errors (spec 2026-09-26 chat-redesign-attachments §5.4). Its own module
 * so the extraction worker (`extract-worker.ts`) can map errors without importing the whisper path.
 */
export type ExtractErrorCode = 'ATTACHMENT_INVALID' | 'TRANSCRIPTION_UNAVAILABLE' | 'TRANSCRIPTION_FAILED';
export class ExtractError extends Error {
  /** The failure is the moment's, not the file's (whisper loading its model): the queue may try again later. */
  readonly retryable: boolean;
  constructor(
    public code: ExtractErrorCode,
    message: string = code,
    opts: { retryable?: boolean } = {},
  ) {
    super(message);
    this.name = 'ExtractError';
    this.retryable = opts.retryable ?? false;
  }
}
