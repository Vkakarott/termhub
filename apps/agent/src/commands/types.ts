/** Shared logger shape passed down from `cli.ts` into every command — English, metadata-only (see CLAUDE.md: "Terminal content is never logged"). */
export type Logger = (msg: string, meta?: object) => void;
