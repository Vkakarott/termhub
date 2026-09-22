/// <reference types="vite/client" />

/** `apps/web`'s own version, injected by `vite.config.ts`; shown in the chat header. */
declare const __APP_VERSION__: string;
/** Build-time stamp (`MM-DD HH:MM`, UTC) injected by `vite.config.ts`; the header's fallback when no commit is known. */
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
  /** Short commit the image was built from, passed as a build arg by `deploy/blue-green.sh`. */
  readonly VITE_BUILD_SHA: string | undefined;
}
