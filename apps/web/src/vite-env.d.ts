/// <reference types="vite/client" />

/** Build-time stamp (`MM-DD HH:MM`, UTC) injected by `vite.config.ts`; shown in the chat header. */
declare const __BUILD_STAMP__: string;

/** Firebase Analytics config, injected at build time (Dockerfile build args). Same values as the landing. */
interface ImportMetaEnv {
  readonly VITE_FIREBASE_API_KEY: string | undefined;
  readonly VITE_FIREBASE_AUTH_DOMAIN: string | undefined;
  readonly VITE_FIREBASE_PROJECT_ID: string | undefined;
  readonly VITE_FIREBASE_STORAGE_BUCKET: string | undefined;
  readonly VITE_FIREBASE_MESSAGING_SENDER_ID: string | undefined;
  readonly VITE_FIREBASE_APP_ID: string | undefined;
  readonly VITE_FIREBASE_MEASUREMENT_ID: string | undefined;
}
